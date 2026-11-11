/* ESP32-S3 SDR console core: no DOM. Ports of esp32-sdr-trx (research/iq-tx):
 *   - the control protocol of firmware/protocol/control.h (src/espdr/nb.py)
 *   - the narrowband receive stream (nb.Link.run, rtltcp.Chain)
 *   - the transmit session of firmware/protocol/transmit.h (src/espdr/txlink.py, cli_tx._lora_plan, txmodes)
 *   - the LoRa PHY (src/espdr/lora_phy.py): encoder and receiver
 *   - esptool's ROM loader (load-ram without stub) over the native USB Serial/JTAG port
 * Works in the browser (Web Serial) and in node (tests), on any "port" with open/readable/writable/setSignals.
 */
(function (root) {
  "use strict";

  // ---------------------------------------------------------------- helpers
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes, start = 0, end = bytes.length) {
    let c = 0xffffffff;
    for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const le16 = (b, o) => b[o] | (b[o + 1] << 8);

  // ---------------------------------------------------------------- FFT (radix 2, in place, interleaved re/im in two arrays)
  const fftCache = new Map();
  function fftPlan(n) {
    let p = fftCache.get(n);
    if (p) return p;
    const rev = new Uint32Array(n);
    let bits = 0;
    while (1 << bits < n) bits++;
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      rev[i] = r;
    }
    const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      cos[i] = Math.cos((-2 * Math.PI * i) / n);
      sin[i] = Math.sin((-2 * Math.PI * i) / n);
    }
    p = { rev, cos, sin };
    fftCache.set(n, p);
    return p;
  }
  function fft(re, im) {
    const n = re.length, { rev, cos, sin } = fftPlan(n);
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j, b = a + half;
          const tr = re[b] * cos[k] - im[b] * sin[k];
          const ti = re[b] * sin[k] + im[b] * cos[k];
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  }

  // ---------------------------------------------------------------- LoRa PHY (port of lora_phy.py)
  let WHITENING = null;
  function whiteningSequence() {
    if (!WHITENING) {
      const s = [0xff];
      for (let i = 0; i < 254; i++) {
        const c = s[s.length - 1];
        s.push(((c << 1) & 0xff) | (((c >> 7) ^ (c >> 5) ^ (c >> 4) ^ (c >> 3)) & 1));
      }
      WHITENING = s;
    }
    return WHITENING;
  }
  function crc16(data) {
    let crc = 0;
    for (let i = 0; i < data.length - 2; i++) {
      let b = data[i];
      for (let k = 0; k < 8; k++) {
        if (((crc & 0x8000) >> 8) ^ (b & 0x80)) crc = ((crc << 1) ^ 0x1021) & 0xffff;
        else crc = (crc << 1) & 0xffff;
        b = (b << 1) & 0xff;
      }
    }
    if (data.length >= 2) crc ^= data[data.length - 1] ^ (data[data.length - 2] << 8);
    return crc & 0xffff;
  }
  const syncSymbols = (sw) => [((sw & 0xf0) >> 4) << 3, (sw & 0x0f) << 3];
  function headerNibbles(len, cr, hasCrc) {
    const h0 = len >> 4, h1 = len & 0x0f, h2 = (cr << 1) | (hasCrc ? 1 : 0);
    const b = (v, k) => (v >> k) & 1;
    const c4 = b(h0, 3) ^ b(h0, 2) ^ b(h0, 1) ^ b(h0, 0);
    const c3 = b(h0, 3) ^ b(h1, 3) ^ b(h1, 2) ^ b(h1, 1) ^ b(h2, 0);
    const c2 = b(h0, 2) ^ b(h1, 3) ^ b(h1, 0) ^ b(h2, 3) ^ b(h2, 1);
    const c1 = b(h0, 1) ^ b(h1, 2) ^ b(h1, 0) ^ b(h2, 2) ^ b(h2, 1) ^ b(h2, 0);
    const c0 = b(h0, 0) ^ b(h1, 1) ^ b(h2, 3) ^ b(h2, 2) ^ b(h2, 1) ^ b(h2, 0);
    return [h0, h1, h2, c4, (c3 << 3) | (c2 << 2) | (c1 << 1) | c0];
  }
  function hammingEncode(nib, crApp) {
    const b0 = nib & 1, b1 = (nib >> 1) & 1, b2 = (nib >> 2) & 1, b3 = (nib >> 3) & 1;
    if (crApp === 1) return (b0 << 4) | (b1 << 3) | (b2 << 2) | (b3 << 1) | (b0 ^ b1 ^ b2 ^ b3);
    const p0 = b0 ^ b1 ^ b2, p1 = b1 ^ b2 ^ b3, p2 = b0 ^ b1 ^ b3, p3 = b0 ^ b2 ^ b3;
    return ((b0 << 7) | (b1 << 6) | (b2 << 5) | (b3 << 4) | (p0 << 3) | (p1 << 2) | (p2 << 1) | p3) >> (4 - crApp);
  }
  function hammingDecode(cw, crApp) {
    const n = 4 + crApp;
    const bits = [];
    for (let k = 0; k < n; k++) bits.push((cw >> (n - 1 - k)) & 1);
    let d = bits.slice(0, 4);
    if (crApp >= 3) {
      const p = bits.slice(4);
      const par = (d) => [d[0] ^ d[1] ^ d[2], d[1] ^ d[2] ^ d[3], d[0] ^ d[1] ^ d[3], d[0] ^ d[2] ^ d[3]].slice(0, p.length);
      const eq = (a, b) => a.every((v, i) => v === b[i]);
      if (!eq(par(d), p)) {
        for (let k = 0; k < 4; k++) {
          const e = d.slice();
          e[k] ^= 1;
          if (eq(par(e), p)) { d = e; break; }
        }
      }
    }
    return d[0] | (d[1] << 1) | (d[2] << 2) | (d[3] << 3);
  }
  function frameSymbols(payload, sf, cr = 1, hasCrc = true, ldro = false) {
    const seq = whiteningSequence();
    const nib = headerNibbles(payload.length, cr, hasCrc);
    for (let i = 0; i < payload.length; i++) {
      const w = payload[i] ^ seq[i];
      nib.push(w & 0x0f, w >> 4);
    }
    if (hasCrc) {
      const c = crc16(payload);
      nib.push(c & 0xf, (c >> 4) & 0xf, (c >> 8) & 0xf, (c >> 12) & 0xf);
    }
    const syms = [];
    let pos = 0, first = true;
    while (pos < nib.length) {
      const sfApp = first || ldro ? sf - 2 : sf;
      const cwLen = first ? 8 : 4 + cr;
      const block = nib.slice(pos, pos + sfApp);
      const cws = block.map((n) => hammingEncode(n, first ? 4 : cr));
      while (cws.length < sfApp) cws.push(0);
      const cb = cws.map((cw) => { const a = []; for (let k = 0; k < cwLen; k++) a.push((cw >> (cwLen - 1 - k)) & 1); return a; });
      for (let i = 0; i < cwLen; i++) {
        const bits = [];
        for (let j = 0; j < sfApp; j++) bits.push(cb[(((i - j - 1) % sfApp) + sfApp) % sfApp][i]);
        while (bits.length < sf) bits.push(0);
        if (first || ldro) { let s = 0; for (let j = 0; j < sfApp; j++) s += bits[j]; bits[sfApp] = s % 2; }
        let v = 0;
        for (const bt of bits) v = (v << 1) | bt;
        let g = v;
        for (let j = 1; j < sf; j++) g ^= v >> j;
        syms.push((g + 1) % (1 << sf));
      }
      pos += sfApp;
      first = false;
    }
    return syms;
  }
  const symbolsPerFrame = (len, sf, cr = 1, preamble = 8, hasCrc = true) => preamble + 4.25 + frameSymbols(new Uint8Array(len), sf, cr, hasCrc).length;
  const frameSamples = (len, sf, os, cr = 1, preamble = 8, hasCrc = true) => Math.round(symbolsPerFrame(len, sf, cr, preamble, hasCrc) * (1 << sf) * os);

  /** The carrier frequency (Hz from the channel centre) at every update of the polar transmitter (lora_phy.frame_track). */
  function frameTrack(payload, sf, bw, rate = 40000, cr = 1, preamble = 8, syncWord = 0x34, hasCrc = true) {
    const N = 1 << sf;
    const sw = syncSymbols(syncWord);
    const syms = [];
    for (let i = 0; i < preamble; i++) syms.push([0, 0]);
    syms.push([0, sw[0]], [0, sw[1]], [1, 0], [1, 0], [2, 0]);
    for (const v of frameSymbols(payload, sf, cr, hasCrc)) syms.push([0, v]);
    const starts = [0];
    for (const [t] of syms) starts.push(starts[starts.length - 1] + (t === 2 ? N * 0.25 : N));
    const total = starts[starts.length - 1];
    const n = Math.ceil((total / bw) * rate), fine = 16;
    const out = new Float64Array(n);
    let k = 0;
    for (let u = 0; u < n; u++) {
      let acc = 0;
      for (let f = 0; f < fine; f++) {
        const chip = (((u * fine + f) + 0.5) / (rate * fine)) * bw;
        while (k + 1 < syms.length && starts[k + 1] <= chip) k++;
        const c = chip - starts[k];
        const [t, v] = syms[k];
        acc += t === 0 ? (((c + v) % N) / N - 0.5) * bw : (0.5 - c / N) * bw;
      }
      out[u] = acc / fine;
    }
    return out;
  }

  // complex helpers on Float32Array pairs (re, im)
  function upchirp(sym, sf) {
    const N = 1 << sf, re = new Float64Array(N), im = new Float64Array(N);
    const nf = N - sym;
    for (let n = 0; n < N; n++) {
      const ph = (n * n) / (2 * N) + (n < nf ? sym / N - 0.5 : sym / N - 1.5) * n;
      re[n] = Math.cos(2 * Math.PI * ph);
      im[n] = Math.sin(2 * Math.PI * ph);
    }
    return { re, im };
  }
  const chirpCache = new Map();
  function refs(sf) {
    let r = chirpCache.get(sf);
    if (!r) {
      const up = upchirp(0, sf);
      r = { up, down: { re: up.re, im: up.im.map((v) => -v) } };
      chirpCache.set(sf, r);
    }
    return r;
  }

  /** |FFT(x[start..start+N] * ref * exp(-2pi j off n / N))|, zero padded to zp*N. */
  function dechirpSpectrum(xr, xi, start, N, ref, off = 0, zp = 1) {
    const M = N * zp, re = new Float64Array(M), im = new Float64Array(M);
    for (let n = 0; n < N; n++) {
      let a = xr[start + n], b = xi[start + n];
      const cr = ref.re[n], ci = ref.im[n];
      let r = a * cr - b * ci, i = a * ci + b * cr;
      if (off) {
        const w = (-2 * Math.PI * off * n) / N, c = Math.cos(w), s = Math.sin(w);
        const r2 = r * c - i * s; i = r * s + i * c; r = r2;
      }
      re[n] = r; im[n] = i;
    }
    fft(re, im);
    const mag = new Float64Array(M);
    for (let i = 0; i < M; i++) mag[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
    return mag;
  }
  function argmax(a) { let k = 0; for (let i = 1; i < a.length; i++) if (a[i] > a[k]) k = i; return k; }
  let medianScratch = new Float64Array(0);
  /** k-th smallest of s[0..n) in place (Hoare's quickselect, expected linear time). */
  function select(s, n, k) {
    let lo = 0, hi = n - 1;
    while (hi > lo) {
      const pivot = s[(lo + hi) >> 1];
      let i = lo, j = hi;
      while (i <= j) {
        while (s[i] < pivot) i++;
        while (s[j] > pivot) j--;
        if (i <= j) { const t = s[i]; s[i] = s[j]; s[j] = t; i++; j--; }
      }
      if (k <= j) hi = j; else if (k >= i) lo = i; else return s[k];
    }
    return s[k];
  }
  function median(a) {
    const n = a.length;
    if (medianScratch.length < n) medianScratch = new Float64Array(n);
    const s = medianScratch;
    for (let i = 0; i < n; i++) s[i] = a[i];
    const m = n >> 1;
    if (n % 2) return select(s, n, m);
    const hi = select(s, n, m);
    let lo = -Infinity;
    for (let i = 0; i < m; i++) if (s[i] > lo) lo = s[i];      // after the select, s[0..m) holds the values below s[m]
    return (lo + hi) / 2;
  }
  function parabolic(mag, k) {
    const N = mag.length;
    const a = Math.log(mag[(k - 1 + N) % N] + 1e-12), b = Math.log(mag[k] + 1e-12), c = Math.log(mag[(k + 1) % N] + 1e-12);
    const d = a - 2 * b + c;
    return k + (d !== 0 ? (0.5 * (a - c)) / d : 0);
  }
  function peakBin(xr, xi, start, N, ref, off = 0, zp = 4) {
    const s = dechirpSpectrum(xr, xi, start, N, ref, off, zp);
    const k = argmax(s);
    return ((parabolic(s, k) / zp) % N + N) % N;
  }
  const wrapc = (v, N) => ((((v + N / 2) % N) + N) % N) - N / 2;
  /** The frequency left in a decided symbol, in bins: dechirp, remove the symbol and the tracked offset, then average the sample-to-sample phase
   * step, leaving out the one step across the chirp's wrap (at chip N - sym), where a residual offset makes the phase jump. Unlike the FFT peak,
   * this is not biased by that jump, so it does not depend on the symbol's value. */
  function residualBins(xr, xi, start, N, ref, shift, sym) {
    let ar = 0, ai = 0, pr = 0, pi = 0;
    const wrapAt = (N - sym) % N;
    for (let n = 0; n < N; n++) {
      const a = xr[start + n], b = xi[start + n], cr = ref.re[n], ci = ref.im[n];
      const w = (-2 * Math.PI * shift * n) / N, c = Math.cos(w), sn = Math.sin(w);
      const r0 = a * cr - b * ci, i0 = a * ci + b * cr;
      const r = r0 * c - i0 * sn, q = r0 * sn + i0 * c;
      if (n > 0 && n !== wrapAt) { ar += r * pr + q * pi; ai += q * pr - r * pi; }
      pr = r; pi = q;
    }
    return (Math.atan2(ai, ar) * N) / (2 * Math.PI);
  }

  /** firwin(numtaps, cutoff) with a Hamming window, unity gain at DC (scipy.signal.firwin's defaults). */
  function firwin(numtaps, cutoff) {
    const h = new Float64Array(numtaps), m = (numtaps - 1) / 2;
    let sum = 0;
    for (let i = 0; i < numtaps; i++) {
      const x = i - m;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * cutoff * x) / (Math.PI * cutoff * x);
      h[i] = cutoff * sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (numtaps - 1)));
      sum += h[i];
    }
    for (let i = 0; i < numtaps; i++) h[i] /= sum;
    return h;
  }
  /** Low-pass to the bandwidth and decimate by os at sample phase `phase` ("same" convolution, as lowpassed()[phase::os]). */
  function toChipRate(re, im, os, phase) {
    const n = re.length, outN = Math.ceil((n - phase) / os);
    const xr = new Float64Array(outN), xi = new Float64Array(outN);
    if (os === 1) { for (let i = 0; i < n; i++) { xr[i] = re[i]; xi[i] = im[i]; } return { xr, xi }; }
    const h = firwin(8 * os + 1, 0.9 / os), L = h.length, half = (L - 1) / 2;
    for (let o = 0, i = phase; i < n; o++, i += os) {
      let ar = 0, ai = 0;
      for (let t = 0; t < L; t++) {
        const j = i + half - t;
        if (j >= 0 && j < n) { ar += h[t] * re[j]; ai += h[t] * im[j]; }
      }
      xr[o] = ar; xi[o] = ai;
    }
    return { xr, xi };
  }

  function detect(xr, xi, sf, preamble = 8, threshold = 6) {
    const N = 1 << sf, stride = Math.max(1, N >> 2);
    const count = Math.floor((xr.length - N) / stride);
    if (count < 4 * preamble) return null;
    const { down } = refs(sf);
    const k = new Int32Array(count), ratio = new Float64Array(count), d = new Int32Array(count);
    for (let w = 0; w < count; w++) {
      const s = dechirpSpectrum(xr, xi, w * stride, N, down);
      const kk = argmax(s);
      k[w] = kk;
      ratio[w] = s[kk] / (median(s) + 1e-12);
      d[w] = (((kk - w * stride) % N) + N) % N;
    }
    const need = 4 * (preamble - 2);
    let best = null;
    for (let i = 0; i < count;) {
      if (!(ratio[i] > threshold)) { i++; continue; }
      let j = i;
      while (j + 1 < count && ratio[j + 1] > threshold && Math.abs(((((d[j + 1] - d[i] + N / 2) % N) + N) % N) - N / 2) <= 2) j++;
      if (j - i + 1 >= need) { best = [i, j]; break; }
      i = j + 1;
    }
    if (!best) return null;
    const [i, j] = best, m = (i + j) >> 1;
    let q = 0;
    for (let t = i; t <= j; t++) q += ratio[t];
    return { tApparent: (((m * stride - k[m]) % N) + N) % N, lo: i * stride, hi: j * stride + N, quality: q / (j - i + 1) };
  }

  function polySlope(y) {
    const n = y.length, mx = (n - 1) / 2;
    let my = 0; for (const v of y) my += v; my /= n;
    let sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) { sxy += (i - mx) * (y[i] - my); sxx += (i - mx) * (i - mx); }
    return sxy / sxx;
  }
  /** The slope of y only where it stands out of its own noise (|slope| > 2 standard errors), else 0: extrapolating a noisy slope over many
   * symbols costs more than it gains when the carrier hardly moves (SF7..10); a real drift (SF11/12, half a bin per symbol) passes. */
  function significantSlope(y) {
    const n = y.length;
    if (n < 4) return 0;
    const b = polySlope(y), mx = (n - 1) / 2;
    let my = 0; for (const v of y) my += v; my /= n;
    let ss = 0, sxx = 0;
    for (let i = 0; i < n; i++) { const r = y[i] - (my + b * (i - mx)); ss += r * r; sxx += (i - mx) * (i - mx); }
    const se = Math.sqrt(ss / (n - 2) / sxx);
    return Math.abs(b) > 2 * se ? b : 0;
  }

  /** Decode one frame from complex samples (re, im) at fs. Port of lora_phy.demodulate (calibrate=False). */
  function demodulate(re, im, fs, sf, bw, opts = {}) {
    const preamble = opts.preamble ?? 8, syncWord = opts.syncWord ?? 0x34, maxPayload = opts.maxPayload ?? 64, track = opts.track ?? 0.6, rateGain = opts.rateGain ?? 0;
    const os = Math.round(fs / bw), N = 1 << sf;
    const { up, down } = refs(sf);
    let best = null;
    const chip = [];
    for (let phase = 0; phase < os; phase++) {
      const c = toChipRate(re, im, os, phase);
      chip.push(c);
      if (phase === 0 && !detect(c.xr, c.xi, sf, preamble)) return null;          // nothing here: skip the other sample phases
      const det = detect(c.xr, c.xi, sf, preamble);
      if (det && (!best || det.quality > best.det.quality)) best = { phase, det, x: c };
    }
    if (!best) return null;
    let { phase, det, x } = best;
    let t0 = det.tApparent;
    while (t0 < det.lo) t0 += N;
    let nPre = Math.floor((det.hi - t0) / N);
    nPre = Math.max(1, Math.min(nPre, preamble - 1));
    const pk0 = argmax(dechirpSpectrum(x.xr, x.xi, t0, N, down));
    const preBins = [];
    for (let r = 0; r < nPre; r++) preBins.push(wrapc(peakBin(x.xr, x.xi, t0 + r * N, N, down) - pk0, N) + pk0);
    let e1 = preBins.reduce((a, b) => a + b, 0) / nPre;
    const drift = opts.driftGate === false ? (nPre >= 4 ? polySlope(preBins) : 0) : significantSlope(preBins);
    e1 = wrapc(e1, N);
    let start = t0;
    while (start - N >= 0) {
      const s = dechirpSpectrum(x.xr, x.xi, start - N, N, down), kk = argmax(s);
      if (s[kk] / (median(s) + 1e-12) > 6 && Math.abs(wrapc(kk - pk0, N)) <= 1) start -= N; else break;
    }
    let kUp = 0, pos = start;
    while (pos + N <= x.xr.length) {
      const s = dechirpSpectrum(x.xr, x.xi, pos, N, down), kk = argmax(s);
      if (s[kk] / (median(s) + 1e-12) > 6 && Math.abs(wrapc(kk - e1, N)) <= 1.5) { kUp++; pos += N; } else break;
    }
    let preStart = start;
    const sfdNominal = preStart + (preamble + 2) * N;
    if (sfdNominal + 2 * N > x.xr.length) return { incomplete: true, start: preStart * os + phase };
    const b2 = wrapc(peakBin(x.xr, x.xi, sfdNominal, N, up), N);
    // e1 was measured over the preamble windows, b2 at the SFD several symbols later: carried forward by the drift, e1 belongs to the SFD's time,
    // so a carrier that moves during a long preamble (SF11/12) is not mistaken for a timing offset
    const e1Pos = (t0 - start) / N + (nPre - 1) / 2;
    const e1AtSfd = !opts.sfdDrift ? e1 : e1 + drift * (preamble + 2 - e1Pos);
    const cfo = (e1AtSfd + b2) / 2, dt = (b2 - e1AtSfd) / 2;
    const trueStart = preStart + dt;
    const S = Math.round(dt * os);
    const tot = preStart * os + phase + S;
    const ph2 = ((tot % os) + os) % os;
    if (os > 1 && ph2 !== phase) x = chip[ph2];
    preStart = Math.floor(tot / os);
    const res = dt - S / os;
    const pay0 = preStart + Math.round((preamble + 4.25) * N);
    const off = !opts.sfdDrift ? cfo - res + drift * (preamble + 4.25 - ((nPre - 1) / 2 + (preamble + 2)) / 2)
      : cfo - res + drift * 2.25;                                         // from the SFD to the first payload symbol
    // SNR from the preamble windows
    let snrAcc = 0, snrN = 0;
    for (let r = 0; r < Math.max(1, Math.min(kUp, preamble - 1)); r++) {
      if (preStart + (r + 1) * N > x.xr.length) break;
      const s = dechirpSpectrum(x.xr, x.xi, preStart + r * N, N, down);
      const pw = s.map((v) => v * v);
      const pk = pw[argmax(pw)], noise = median(pw) / Math.log(2);
      snrAcc += 10 * Math.log10(Math.max(pk - noise, 1e-9) / (N * noise + 1e-12));
      snrN++;
    }
    const out = { timingChips: trueStart, cfoBins: cfo, cfoHz: (cfo * bw) / N, phase, quality: det.quality, snrDb: snrN ? snrAcc / snrN : NaN,
      start: Math.round(trueStart * os + phase) };

    const decode = (off0) => {
      // second-order tracking: the offset moves by `rate` bins per symbol (the carrier drifts while a long frame goes on); the fractional part of each
      // decided bin corrects both. Starting from the preamble's slope, it keeps following when the drift would otherwise pass half a bin and flip symbols.
      let state = off0, rate = drift, last = 0;
      const seen = [];
      const symAt = (i) => {
        const s0 = pay0 + i * N;
        if (s0 + N > x.xr.length) return null;
        state += rate * (i - last); last = i;
        const p = peakBin(x.xr, x.xi, s0, N, down, state);
        const sym = ((Math.round(p) % N) + N) % N;
        const frac = opts.unbiased ? residualBins(x.xr, x.xi, s0, N, down, state + sym, sym) : wrapc(p - sym, N);
        state += track * frac;
        rate += rateGain * frac;
        if (opts.trace) opts.trace.push({ i, p, sym, frac, state, rate });
        seen.push(sym);
        return sym;
      };
      const blockNibbles = (i0, sfApp, cwLen, crApp) => {
        const v = [];
        for (let i = 0; i < cwLen; i++) { const s = symAt(i0 + i); if (s === null) return null; v.push(s); }
        const cws = Array.from({ length: sfApp }, () => new Array(cwLen).fill(0));
        v.forEach((s, i) => {
          const x_ = (((s - 1) % N) + N) % N, g = x_ ^ (x_ >> 1);
          for (let j = 0; j < sfApp; j++) cws[(((i - j - 1) % sfApp) + sfApp) % sfApp][i] = (g >> (sf - 1 - j)) & 1;
        });
        return cws.map((row) => hammingDecode(row.reduce((c, bt) => (c << 1) | bt, 0), crApp));
      };
      const fail = (extra) => Object.assign({}, out, { payload: null, headerOk: false, crcOk: false, symbols: seen }, extra);
      let nib = blockNibbles(0, sf - 2, 8, 4);
      if (!nib) return fail({ incomplete: true });
      const plen = (nib[0] << 4) | nib[1], cr = nib[2] >> 1, hasCrc = !!(nib[2] & 1);
      if (!(cr >= 1 && cr <= 4) || plen === 0 || plen > maxPayload) return fail();
      const hdr = headerNibbles(plen, cr, hasCrc);
      if (nib[3] !== hdr[3] || nib[4] !== hdr[4]) return fail({ payloadLen: plen, cr });
      const need = 5 + 2 * plen + (hasCrc ? 4 : 0);
      let symI = 8;
      while (nib.length < need) {
        const more = blockNibbles(symI, sf, 4 + cr, cr);
        if (!more) return fail({ incomplete: true, headerOk: true, payloadLen: plen, cr });
        nib = nib.concat(more);
        symI += 4 + cr;
      }
      const seq = whiteningSequence(), body = nib.slice(5, 5 + 2 * plen);
      const payload = new Uint8Array(plen);
      for (let i = 0; i < plen; i++) payload[i] = (body[2 * i] | (body[2 * i + 1] << 4)) ^ seq[i];
      let crcOk = true;
      if (hasCrc) {
        const c = nib.slice(5 + 2 * plen, 5 + 2 * plen + 4);
        crcOk = (c[0] | (c[1] << 4) | (c[2] << 8) | (c[3] << 12)) === crc16(payload);
      }
      return Object.assign({}, out, { symbols: seen, payload, payloadLen: plen, cr, hasCrc, headerOk: true, crcOk,
        end: out.start + frameSamples(plen, sf, os, cr, preamble, hasCrc) });
    };
    // the offset is known modulo N / 2 bins only: try the other candidate if the header (or, with a header that happens to check, the CRC) fails
    const first = decode(off);
    if (first.headerOk && first.crcOk) return first;
    const second = decode(off < 0 ? off + N / 2 : off - N / 2);
    if (second.headerOk && (second.crcOk || !first.headerOk)) return second;
    return first;
  }

  /** Mixes (re, im) by -shiftHz (moves a signal at +shiftHz to 0). */
  function mix(re, im, fs, shiftHz) {
    const n = re.length, or = new Float64Array(n), oi = new Float64Array(n);
    const w = (-2 * Math.PI * shiftHz) / fs;
    let c = 1, s = 0;
    const dc = Math.cos(w), ds = Math.sin(w);
    for (let i = 0; i < n; i++) {
      or[i] = re[i] * c - im[i] * s; oi[i] = re[i] * s + im[i] * c;
      const c2 = c * dc - s * ds; s = c * ds + s * dc; c = c2;
      if ((i & 1023) === 1023) { const m = Math.hypot(c, s); c /= m; s /= m; }
    }
    return { re: or, im: oi };
  }

  /** Centre of the strongest burst (lora_phy.coarse_centre, without Welch: the averaged power spectrum of 80 ms after the burst starts). */
  function coarseCentre(re, im, fs, nper = 4096) {
    const n = re.length, blk = Math.max(1, Math.floor(fs * 0.002));
    let mr = 0, mi = 0;
    for (let i = 0; i < n; i++) { mr += re[i]; mi += im[i]; }
    mr /= n; mi /= n;
    const nb = Math.floor(n / blk), env = new Float64Array(nb);
    for (let b = 0; b < nb; b++) {
      let s = 0;
      for (let i = b * blk; i < (b + 1) * blk; i++) { const u = re[i] - mr, v = im[i] - mi; s += Math.sqrt(u * u + v * v); }
      env[b] = (s / blk) ** 2;
    }
    const emax = env[argmax(env)];
    let on = 0;
    while (on < nb && !(env[on] > 0.3 * emax)) on++;
    const a = on * blk + 5 * blk, len = Math.min(Math.floor(0.08 * fs), n - a);
    const M = Math.min(nper, 1 << Math.floor(Math.log2(Math.max(len, 16))));
    const p = new Float64Array(M);
    let segs = 0;
    for (let s0 = a; s0 + M <= a + len; s0 += M >> 1) {
      const r = new Float64Array(M), i2 = new Float64Array(M);
      for (let i = 0; i < M; i++) { const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / M); r[i] = (re[s0 + i] - mr) * w; i2[i] = (im[s0 + i] - mi) * w; }
      fft(r, i2);
      for (let i = 0; i < M; i++) p[i] += r[i] * r[i] + i2[i] * i2[i];
      segs++;
    }
    if (!segs) return 0;
    const pmax = p[argmax(p)];
    let fmin = Infinity, fmax = -Infinity;
    for (let i = 0; i < M; i++) {
      if (p[i] > 0.05 * pmax) {
        const f = ((i < M / 2 ? i : i - M) * fs) / M;
        fmin = Math.min(fmin, f); fmax = Math.max(fmax, f);
      }
    }
    return (fmin + fmax) / 2;
  }

  /** All frames of a recording. Returns {frames, consumed}: consumed = samples that can be dropped (keeps an incomplete frame at the end). */
  function demodulateAll(re, im, fs, sf, bw, opts = {}) {
    const os = Math.round(fs / bw), N = 1 << sf;
    const frames = [];
    let base = 0;
    while (re.length - base > 12 * N * os) {
      const r = demodulate(re.subarray(base), im.subarray(base), fs, sf, bw, opts);
      if (!r) break;
      if (r.incomplete) return { frames, consumed: base + Math.max(0, r.start - N * os) };
      const end = r.end || r.start + 8 * N * os;
      frames.push(Object.assign(r, { start: r.start + base, end: end + base }));
      base += Math.max(end, 1);
    }
    // nothing more found: keep the length of one long frame at the end, which may hold the start of the next one
    const keep = frameSamples(opts.keepPayload ?? 48, sf, os) + 2 * N * os;
    return { frames, consumed: Math.max(base, re.length - keep) };
  }

  /** Live LoRa reception: push() chunks of samples, process() decodes what is complete. The centre is searched around the strongest burst
   * (both boards' crystals put the signal tens of kHz away from where it was sent) and the last good offset is tried first. */
  class RxDecoder {
    constructor(fs, sf, bw, opts = {}) {
      this.fs = fs; this.sf = sf; this.bw = bw; this.opts = opts;
      this.re = new Float32Array(0); this.im = new Float32Array(0);
      this.lastShift = null;
      this.searchSpan = opts.searchSpan ?? fs / 2;      // the whole window: a signal past its edge wraps around (the sampled spectrum is circular)
      this.dropped = 0;              // samples consumed before the buffer start (absolute time base)
    }
    push(re, im) {
      this.fresh = (this.fresh || 0) + re.length;
      const n = this.re.length + re.length, r = new Float32Array(n), i = new Float32Array(n);
      r.set(this.re); r.set(re, this.re.length); i.set(this.im); i.set(im, this.im.length);
      this.re = r; this.im = i;
    }
    _consume(n) {
      n = Math.max(0, Math.min(n, this.re.length));
      this.re = this.re.slice(n); this.im = this.im.slice(n);
      this.dropped += n;
    }
    /** Returns the decoded frames (with shiftHz = where the signal was, against the tuning, and t = seconds since the start). */
    process() {
      const os = Math.round(this.fs / this.bw), N = 1 << this.sf;
      if (this.re.length < 16 * N * os || this.fresh < Math.max(this.fs * 0.3, 4 * N * os)) return [];
      this.fresh = 0;
      // is there a burst at all? (power well above the median of 2 ms blocks)
      const blk = Math.floor(this.fs * 0.002), nb = Math.floor(this.re.length / blk), env = new Float64Array(nb);
      for (let b = 0; b < nb; b++) { let s = 0; for (let k = b * blk; k < (b + 1) * blk; k++) s += this.re[k] * this.re[k] + this.im[k] * this.im[k]; env[b] = s / blk; }
      const med = median(env), peak = env[argmax(env)];
      this.level = { medianPower: med, peakPower: peak };
      const keep = frameSamples(this.opts.keepPayload ?? 48, this.sf, os) + 2 * N * os;
      const shifts = [];
      const wrap = (f) => f - this.fs * Math.round(f / this.fs);
      const add = (s) => { s = wrap(s); if (!shifts.some((v) => Math.abs(wrap(v - s)) < this.bw / 10)) shifts.push(s); };
      if (this.lastShift !== null) add(this.lastShift);
      const c0 = coarseCentre(this.re, this.im, this.fs);
      for (const k of this.lastShift === null ? [0, 1, -1, 2, -2] : [0, 1, -1]) add(c0 + (k * this.bw) / 5);   // once locked: the known offset and the spectrum's guess
      // then the whole span: a strong steady signal elsewhere (a carrier, a spur) pulls the coarse centre away from the frames
      // until a frame decodes, and then on every 4th pass, also the whole span (it costs one filter and preamble search per step)
      this.passes = (this.passes || 0) + 1;
      if (this.opts.wide || this.lastShift === null || this.passes % 4 === 0) for (let s = -this.searchSpan; s < this.searchSpan; s += this.bw / 2.5) add(s);
      let best = null;
      for (const s of shifts) {
        const m = mix(this.re, this.im, this.fs, s);
        const r = demodulateAll(m.re, m.im, this.fs, this.sf, this.bw, this.opts);
        const score = r.frames.reduce((a, f) => a + (f.crcOk ? 100 : f.headerOk ? 10 : 0), 0);
        if (!best || score > best.score) best = { s, r, score };
        if (score >= 100) break;
      }
      const { s, r } = best;
      if (best.score >= 100) this.lastShift = s;
      const frames = r.frames.filter((f) => f.headerOk || f.crcOk).map((f) => Object.assign(f, { shiftHz: s + f.cfoHz, t: (this.dropped + f.start) / this.fs }));
      this._consume(r.consumed);
      return frames;
    }
  }

  // ---------------------------------------------------------------- control protocol (control.h)
  const OP = { CTL_INFO: 1, CTL_STATUS: 3, ESP_RUN: 17, ESP_STOP: 18, ESP_ARG_HIGH: 19, ESP_SET_LO: 20, ESP_SET_RATE: 21, ESP_SET_WIDTH: 22, ESP_SET_GAIN: 24,
    NB_SET_DECIM: 29, NB_SET_FORMAT: 30, NB_SET_OUTSHIFT: 31,
    TX_OP_LO: 40, TX_OP_RATE: 41, TX_OP_DRIFT: 42, TX_OP_LIMIT: 43, TX_OP_BEGIN: 44, TX_OP_END: 45, TX_OP_TEMP: 46, TX_OP_RANGE: 47 };
  const REQ_MAGIC = 0xb4, RESP_MAGIC = 0xb5, NB_MAGIC0 = 0xe5, NB_MAGIC1 = 0x5d, NB_HEADER = 20, TX_STATUS_MAGIC = 0xb6;
  const FIRMWARE_ID = 0x49515306, CTL_BUILD_TX = 2;
  const STATUS_NAMES = { 0: "ok", 1: "unknown op", 2: "bad argument", 3: "busy", 4: "not ready", 5: "run failed", 6: "failed" };
  const FAIL_NAMES = { 1: "bank ownership changed", 2: "late poll", 3: "late switch", 4: "unit end not found", 5: "unit start not found", 6: "bad unit length",
    7: "bank still busy (DSP too slow)", 8: "next bank prepared too late (DSP too slow)", 9: "radio init failed" };

  class ProtocolError extends Error {}

  /** A byte pipe over a Web Serial-like port: background reader into a growing buffer, awaitable waits. */
  class Pipe {
    constructor(port) {
      this.port = port;
      this.buf = new Uint8Array(1 << 16);
      this.len = 0;
      this.waiters = [];
      this.closed = false;
      this.onBytes = null;          // optional tap: (Uint8Array) => true to consume them (stream mode)
    }
    async start() {
      this.writer = this.port.writable.getWriter();
      this.reader = this.port.readable.getReader();
      this.loop = (async () => {
        try {
          for (;;) {
            const { value, done } = await this.reader.read();
            if (done) break;
            if (value && value.length) this._push(value);
          }
        } catch (e) {
          this.error = e;
        } finally {
          this.closed = true;
          this._wake();
        }
      })();
    }
    _push(v) {
      if (this.len + v.length > this.buf.length) {
        let n = this.buf.length;
        while (n < this.len + v.length) n *= 2;
        const b = new Uint8Array(n);
        b.set(this.buf.subarray(0, this.len));
        this.buf = b;
      }
      this.buf.set(v, this.len);
      this.len += v.length;
      this._wake();
    }
    _wake() { const w = this.waiters; this.waiters = []; w.forEach((f) => f()); }
    data() { return this.buf.subarray(0, this.len); }
    drop(n) { this.buf.copyWithin(0, n, this.len); this.len -= n; }
    clear() { this.len = 0; }
    /** Waits until at least `n` bytes are buffered or `ms` elapse; returns true if they are. */
    async want(n, ms) {
      const end = Date.now() + ms;
      while (this.len < n) {
        if (this.closed) throw new ProtocolError("the port was closed" + (this.error ? ": " + this.error.message : ""));
        const left = end - Date.now();
        if (left <= 0) return false;
        await new Promise((r) => { const t = setTimeout(r, left); this.waiters.push(() => { clearTimeout(t); r(); }); });
      }
      return true;
    }
    async write(bytes) { await this.writer.write(bytes); }
    async close() {
      try { await this.reader.cancel(); } catch (e) { /* already gone */ }
      try { this.reader.releaseLock(); } catch (e) { /* ignore */ }
      try { this.writer.releaseLock(); } catch (e) { /* ignore */ }
      await this.loop;
    }
  }

  function request(op, arg, seq) {
    const b = new Uint8Array(10);
    b[0] = REQ_MAGIC; b[1] = op; b[2] = arg & 0xff; b[3] = (arg >> 8) & 0xff; b[4] = seq & 0xff; b[5] = (seq >> 8) & 0xff;
    const c = crc32(b, 0, 6);
    b[6] = c & 0xff; b[7] = (c >>> 8) & 0xff; b[8] = (c >>> 16) & 0xff; b[9] = (c >>> 24) & 0xff;
    return b;
  }
  /** A response frame at the start of d, or null: {op, status, value}. */
  function parseResponse(d, o = 0) {
    if (d.length - o < 16 || d[o] !== RESP_MAGIC) return null;
    if (le32(d, o + 12) !== crc32(d, o, o + 12)) return null;
    return { op: d[o + 2], status: d[o + 3], value: le32(d, o + 8) };
  }

  class Link {
    constructor(pipe, log = () => {}) { this.pipe = pipe; this.seq = 0; this.log = log; }
    _next() { this.seq = (this.seq + 1) & 0xffff; return this.seq; }
    async send(op, arg = 0) {
      arg = Math.round(arg);
      if (arg > 0xffff) {
        await this.pipe.write(request(OP.ESP_ARG_HIGH, Math.floor(arg / 65536) & 0xffff, this._next()));
        await this.response(OP.ESP_ARG_HIGH);
      }
      await this.pipe.write(request(op, arg & 0xffff, this._next()));
    }
    async response(op, ms = 5000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (!(await this.pipe.want(1, 200))) continue;
        const d = this.pipe.data();
        if (d[0] !== RESP_MAGIC) { this.pipe.drop(1); continue; }
        if (!(await this.pipe.want(16, 500))) continue;
        const r = parseResponse(this.pipe.data());
        if (!r) { this.pipe.drop(1); continue; }
        this.pipe.drop(16);
        if (r.op === op) return r;
      }
      throw new ProtocolError(`no response to op ${op}`);
    }
    async command(op, arg = 0, allow = [0], ms = 5000) {
      await this.send(op, arg);
      const r = await this.response(op, ms);
      if (!allow.includes(r.status)) {
        const e = new ProtocolError(`op ${op} arg ${arg}: ${STATUS_NAMES[r.status] || "status " + r.status}`);
        e.status = r.status; e.op = op;
        throw e;
      }
      return r;
    }
    /** {firmwareOk, tx} of the firmware that runs (throws if nothing answers). */
    async info(ms = 5000) {
      const id = (await this.command(OP.CTL_INFO, 0, [0], ms)).value;
      if (id !== FIRMWARE_ID) throw new ProtocolError(`unexpected firmware id 0x${id.toString(16)}`);
      const flags = (await this.command(OP.CTL_INFO, 3, [0, 1, 2])).value;
      return { tx: !!(flags & CTL_BUILD_TX), flags };
    }
  }

  // ---------------------------------------------------------------- receiver
  const RX_RATE = 250000;
  /** Configures the narrowband receiver (nb.configure_receiver with decim 4, cs8; shift 4 is the default output shift). gainSel: the chip's selector 0..127 (rtl_tcp maps 0..49.6 dB to 30..80). */
  async function configureReceiver(link, freqHz, gainSel, shift = 4) {
    await link.command(OP.ESP_SET_RATE, 1);
    await link.command(OP.ESP_SET_WIDTH, 20);
    const lo = (await link.command(OP.ESP_SET_LO, Math.round(freqHz))).value;
    await link.command(OP.ESP_SET_GAIN, gainSel);
    await link.command(OP.NB_SET_DECIM, 4);
    await link.command(OP.NB_SET_FORMAT, 1);
    await link.command(OP.NB_SET_OUTSHIFT, Math.max(0, Math.min(12, shift)));     // every step above 4 halves the samples (-6 dB)
    return lo;
  }
  // rtl_tcp's mapping (0 .. 49.6 dB -> selector 30 .. 80), extended below 0 dB down to selector 0 (the table is about 1 dB per step from 35 to 76 only)
  const gainDbToSel = (db) => Math.max(0, Math.min(127, Math.round(30 + (50 * Math.max(-30, Math.min(49.6, db))) / 49.6)));

  /** Streams until stop() is true. onSamples(re: Float32Array, im: Float32Array, clipped: samples with I or Q at the 8-bit limit) gets conjugated samples (a higher RF is a higher frequency), DC removed.
   * Returns {status, value, stats}. */
  async function runReceiver(link, onSamples, stop) {
    const pipe = link.pipe;
    await link.send(OP.ESP_RUN, 0);
    const stats = { packets: 0, samples: 0, lost: 0, skipped: 0, bad: 0, dropped: 0 };
    let expected = null, stopped = false, tLast = Date.now(), dcR = 0, dcI = 0, dcInit = false;
    let outR = new Float32Array(1 << 16), outI = new Float32Array(1 << 16), nOut = 0, nClip = 0;
    const room = (k) => {
      if (nOut + k <= outR.length) return;
      let n = outR.length;
      while (n < nOut + k) n *= 2;
      const r = new Float32Array(n), i = new Float32Array(n);
      r.set(outR.subarray(0, nOut)); i.set(outI.subarray(0, nOut));
      outR = r; outI = i;
    };
    const flush = () => {
      if (!nOut) return;
      const re = outR.slice(0, nOut), im = outI.slice(0, nOut);
      let mr = 0, mi = 0;
      for (let i = 0; i < nOut; i++) { mr += re[i]; mi += im[i]; }
      mr /= nOut; mi /= nOut;
      const a = Math.min(1, nOut / (0.5 * RX_RATE));
      if (!dcInit) { dcR = mr; dcI = mi; dcInit = true; } else { dcR += a * (mr - dcR); dcI += a * (mi - dcI); }
      for (let i = 0; i < nOut; i++) { re[i] -= dcR; im[i] -= dcI; }
      nOut = 0;
      const clipped = nClip;
      nClip = 0;
      onSamples(re, im, clipped);
    };
    for (;;) {
      if (!stopped && stop()) { await pipe.write(request(OP.ESP_STOP, 0, link._next())); stopped = true; }
      if (!(await pipe.want(1, 50))) {
        if (Date.now() - tLast > 10000) throw new ProtocolError("the stream stalled for 10 s");
        continue;
      }
      tLast = Date.now();
      const d = pipe.data();
      let o = 0;
      while (o < d.length) {
        const b0 = d[o];
        if (b0 === RESP_MAGIC) {
          if (d.length - o < 16) break;
          const r = parseResponse(d, o);
          if (r) {
            o += 16;
            if (r.op === OP.ESP_RUN) { pipe.drop(o); flush(); return { status: r.status, value: r.value, stats }; }
            continue;
          }
        }
        if (b0 === NB_MAGIC0) {
          if (d.length - o < NB_HEADER) break;
          if (d[o + 1] === NB_MAGIC1) {
            let sum = 0;
            for (let w = 0; w < 10; w++) sum += d[o + 2 * w] | (d[o + 2 * w + 1] << 8);
            if ((sum & 0xffff) === 0xffff) {
              const fmt = d[o + 2], count = le16(d, o + 4), dropped = le16(d, o + 6), first = (le16(d, o + 12) | (le16(d, o + 14) << 16)) >>> 0;
              const size = NB_HEADER + count * (fmt === 1 ? 2 : 4);
              if (d.length - o < size) break;
              if (expected !== null && first !== expected) {
                const lost = Math.min((first - expected) >>> 0, RX_RATE);
                stats.lost += lost;
                room(lost);
                outR.fill(0, nOut, nOut + lost); outI.fill(0, nOut, nOut + lost);
                nOut += lost;
              }
              expected = (first + count) >>> 0;
              stats.packets++; stats.samples += count; stats.dropped = dropped;
              room(count);
              const p = o + NB_HEADER;
              if (fmt === 1) {
                for (let i = 0, j = p; i < count; i++, j += 2) {
                  const a = (d[j] << 24) >> 24, b = (d[j + 1] << 24) >> 24;
                  if (a >= 127 || a <= -127 || b >= 127 || b <= -127) nClip++;      // a component at the 8-bit limit
                  outR[nOut + i] = a;
                  outI[nOut + i] = -b;                                              // conjugate: the radio gives LO minus RF
                }
              } else {
                for (let i = 0, j = p; i < count; i++, j += 4) {
                  outR[nOut + i] = (((d[j] | (d[j + 1] << 8)) << 16) >> 16) / 256;
                  outI[nOut + i] = -((((d[j + 2] | (d[j + 3] << 8)) << 16) >> 16) / 256);
                }
              }
              nOut += count;
              o += size;
              continue;
            }
          }
          stats.bad++;
        }
        o++;
        stats.skipped++;
      }
      pipe.drop(o);
      if (nOut >= RX_RATE * 0.02) flush();                       // hand out about 20 ms at a time
      if (o === 0) await pipe.want(pipe.len + 1, 50);           // only part of a packet: wait for the rest (and let the reader run)
    }
  }

  // ---------------------------------------------------------------- transmitter
  const TX_MIN_HZ = 2320e6, TX_MAX_HZ = 2450e6, PLL_STEP_HZ = 30e6 / 65536, Q4_HZ = PLL_STEP_HZ / 16;
  const GAIN_CURVE = [[127, 0.0], [124, 1.32], [121, 1.94], [118, 2.79], [115, 3.82], [112, 4.74], [109, 5.22], [106, 6.05], [103, 7.03], [100, 8.05], [97, 8.79],
    [94, 9.78], [91, 10.56], [88, 11.57], [85, 12.26], [82, 13.07], [79, 13.91], [76, 14.76], [73, 15.51], [70, 16.33], [67, 17.12], [64, 17.9]];
  const RANGE_DB = 17.9;
  function peakCode(powerDb) {
    if (powerDb > 0) throw new Error("the power cannot be above 0 dB (the strongest setting)");
    if (powerDb < -RANGE_DB) throw new Error(`the weakest possible power is ${-RANGE_DB} dB`);
    const db = RANGE_DB + powerDb;                       // dB above code 127
    for (let i = 0; i + 1 < GAIN_CURVE.length; i++) {
      const [c0, d0] = GAIN_CURVE[i], [c1, d1] = GAIN_CURVE[i + 1];
      if (db >= d0 && db <= d1) return Math.round(c0 + ((db - d0) / (d1 - d0)) * (c1 - c0));
    }
    return 64;
  }
  // PLL word arithmetic in BigInt-free doubles (values < 2^53)
  const loWord = (hz) => Math.floor((hz * 65536 + 15e6) / 30e6) - 32 * 65536;
  const wordHz = (w) => 30e6 * (32 + w / 65536);
  /** cli_tx._lora_plan: the LO (100 Hz units) that makes the chirp fit in one byte of the PLL word, and the range of offsets. */
  function loraPlan(freqHz, bw, ppm = 0) {
    const p = 1 + ppm * 1e-6;
    const rangeSteps = Math.max(44, Math.ceil(bw / 2 / PLL_STEP_HZ) + 3);
    if (rangeSteps > 90) throw new Error("the chirp is wider than the records can carry");
    const margin = rangeSteps + 4;
    let word = loWord(Math.round(freqHz / p));
    const low = word & 0xff;
    if (low < margin) word += margin - low;
    else if (low > 255 - margin) word -= low - (255 - margin);
    let loHz = Math.round(wordHz(word) / 100) * 100;
    for (let k = 0; k < 6 && loWord(loHz) !== word; k++) loHz += loWord(loHz) < word ? 100 : -100;
    const centre = wordHz(loWord(loHz)) * p;
    return { loHz, centreHz: centre, rangeSteps, movedHz: centre - freqHz, word: loWord(loHz), ppm };
  }
  /** Records (Uint32Array) of one frame: the frequency in 1/16 PLL steps, the gain code; no end record. */
  function loraRecords(payload, sf, bw, cr, powerDb, plan, rate = 40000, preamble = 8, syncWord = 0x34) {
    // the chip's 40 kHz update clock comes from the same crystal as its carrier: when that runs ppm off, so do the chirps' timing. Rendering the
    // track for the clock's real rate keeps the chips in step with an accurate receiver (a long frame would otherwise slip by whole chips)
    const f = frameTrack(payload, sf, bw, rate * (1 + (plan.ppm || 0) * 1e-6), cr, preamble, syncWord);
    const code = peakCode(powerDb), limit = (plan.rangeSteps - 2) * 16;
    const rec = new Uint32Array(f.length);
    for (let i = 0; i < f.length; i++) {
      const q = Math.max(-limit, Math.min(limit, Math.round(f[i] / Q4_HZ)));
      rec[i] = ((q & 0xffff) | (code << 16)) >>> 0;
    }
    return rec;
  }
  const END_REASONS = { 0: "finished", 1: "the chip stopped: no data for 500 ms", 2: "the longest session was reached", 3: "the receiver could not be set up again" };

  /** One transmission of `records` (txlink.Session configure/begin/stream). onStatus(ev) for the chip's status frames. Returns the summary. */
  async function transmit(link, plan, records, onStatus = () => {}, rate = 40000) {
    await link.command(OP.TX_OP_LO, Math.round(plan.loHz / 100));
    await link.command(OP.TX_OP_RATE, rate);
    await link.command(OP.TX_OP_DRIFT, 0);
    await link.command(OP.TX_OP_LIMIT, 60);
    if (plan.rangeSteps !== 44) await link.command(OP.TX_OP_RANGE, plan.rangeSteps);
    let begin;
    try { begin = await link.command(OP.TX_OP_BEGIN, 0); }
    catch (e) { throw new ProtocolError(e.status === 6 ? "the PLL did not lock at this frequency" : e.status === 4 ? "the receiver of the chip is not ready" : e.message); }
    if (begin.value !== plan.word) throw new ProtocolError(`the chip programmed PLL word 0x${begin.value.toString(16)}, expected 0x${plan.word.toString(16)}`);
    const pipe = link.pipe;
    const targetFill = 8000;
    let pos = 0, fill = 0, sentSince = 0, endSent = false;
    const t0 = Date.now();
    for (;;) {
      // parse what the chip sent
      let d = pipe.data(), o = 0;
      while (o < d.length) {
        if (d[o] === TX_STATUS_MAGIC) {
          if (d.length - o < 8) break;
          let s = 0;
          for (let i = 0; i < 8; i++) s += d[o + i];
          if ((s & 0xff) === 0) {
            const ev = { seq: d[o + 1], fill: le16(d, o + 2), underruns: d[o + 4], late: d[o + 5], carrier: !!(d[o + 6] & 1) };
            fill = ev.fill; sentSince = 0;
            onStatus(ev, pos / records.length);
            o += 8;
            continue;
          }
        } else if (d[o] === RESP_MAGIC) {
          if (d.length - o < 16) break;
          const r = parseResponse(d, o);
          if (r) {
            o += 16;
            if (r.op === OP.TX_OP_END) {
              pipe.drop(o);
              return { reason: r.value >>> 24, underruns: (r.value >> 16) & 0xff, late: r.value & 0xffff, text: END_REASONS[r.value >>> 24] || "?" };
            }
            continue;
          }
        }
        o++;
      }
      pipe.drop(o);
      if (!endSent) {
        const room = targetFill - fill - sentSince;
        if (pos < records.length && room >= 256) {
          const n = Math.min(room, records.length - pos, 4096);
          await pipe.write(new Uint8Array(records.buffer.slice(pos * 4, (pos + n) * 4)));
          pos += n; sentSince += n;
        } else if (pos >= records.length) {
          await pipe.write(new Uint8Array(new Uint32Array([(127 << 16) | (1 << 24)]).buffer));
          endSent = true;
        }
      }
      if (Date.now() - t0 > 60000) throw new ProtocolError("the transmission did not end");
      await pipe.want(pipe.len + 1, 3);
    }
  }

  // ---------------------------------------------------------------- LORA32 (github.com/lozaning/LORA32, INFO19): a LoRa-style modem in the flash, text line protocol
  const LORA32_ID = "S3SDR-CODEX";
  /** Line client for the LORA32 machine protocol (docs/SERIAL-PROTOCOL.md). One command at a time; MODEMRX records go to onRx. */
  class Lora32 {
    constructor(pipe, onRx = () => {}, onLine = () => {}) {
      this.pipe = pipe; this.onRx = onRx; this.onLine = onLine;
      this.waiter = null; this.queue = Promise.resolve();
      this.dec = new TextDecoder();
      this.running = true;
      this.loop = this._read();
    }
    async _read() {
      while (this.running && !this.pipe.closed) {
        try { if (!(await this.pipe.want(1, 200))) continue; } catch (e) { break; }
        const d = this.pipe.data();
        let start = 0;
        for (let i = 0; i < d.length; i++) {
          if (d[i] !== 10) continue;
          const line = this.dec.decode(d.subarray(start, i)).replace(/\r$/, "");
          start = i + 1;
          this._line(line);
        }
        if (start) this.pipe.drop(start);
        else await this.pipe.want(this.pipe.len + 1, 200).catch(() => {});
      }
    }
    _line(line) {
      if (!line) return;
      if (line.startsWith("MODEMRX ")) {
        const f = line.split(/\s+/);
        if (f.length === 7) {
          const bytes = Uint8Array.from((f[6].match(/../g) || []).map((h) => parseInt(h, 16)));
          const ok = bytes.length === +f[4] && crc32(bytes) === parseInt(f[5], 16);
          this.onRx({ source: +f[1], destination: +f[2], sequence: +f[3], bytes, ok });
          return;
        }
      }
      this.onLine(line);
      if (this.waiter) this.waiter(line);
    }
    /** Sends a line and collects lines until done(line) is true; returns them. Serialised: one command at a time. */
    request(text, done, ms = 3000, after = null) {
      const run = async () => {
        const lines = [];
        const p = new Promise((resolve, reject) => {
          const t = setTimeout(() => { this.waiter = null; reject(new ProtocolError(`no answer to ${text.split(" ")[0]}${lines.length ? " (got: " + lines.join(" / ") + ")" : ""}`)); }, ms);
          this.waiter = async (line) => {
            lines.push(line);
            if (after && line.startsWith("READY")) { const a = after; after = null; await this.pipe.write(a); return; }
            if (done(line)) { clearTimeout(t); this.waiter = null; resolve(lines); }
          };
        });
        await this.pipe.write(new TextEncoder().encode(text + "\n"));
        return p;
      };
      const r = this.queue.then(run, run);
      this.queue = r.catch(() => {});
      return r;
    }
    async cmd(text, ms = 3000) {
      const lines = await this.request(text, (l) => l.startsWith("OK") || l.startsWith("ERR"), ms);
      const last = lines[lines.length - 1];
      if (last.startsWith("ERR")) throw new ProtocolError(`${text}: ${last}`);
      return lines;
    }
    async sync() {
      const n = String(Math.floor(Math.random() * 1e9));
      // end whatever partial line is in the modem's buffer (a probe for the other firmware leaves bytes there), then take over
      await this.pipe.write(new TextEncoder().encode("\n"));
      await sleep(200);
      try { await this.request("SYNC " + n, (l) => l.includes(n), 1500); }
      catch (e) { await this.request("SYNC " + n, (l) => l.includes(n), 1500); }
      const info = await this.request("INFO", (l) => l.startsWith(LORA32_ID) || l.startsWith("ERR"), 1500);
      const id = info.find((l) => l.startsWith(LORA32_ID));
      if (!id) throw new ProtocolError("not LORA32");
      return id;
    }
    /** The documented setup: LORA7 PHY, LO 2437 MHz (carrier 2439.5 MHz), manual gain, node id, ACKs for unicast on/off, receiver on. */
    async start(node, reliable = true, gain = 65) {
      for (const c of ["MODEMOFF", "FREQ 2437", `GAINMANUAL ${gain}`, "MODEMPHY LORA7", `MODEMCONF ${node} 255 1 1`, `MODEMREL ${reliable ? 1 : 0}`, "MODEMACKDROP 0", "MODEMON"]) await this.cmd(c);
    }
    stop() { return this.cmd("MODEMOFF"); }
    /** Sends bytes (1..256) to destination 1..254 or 255 (broadcast). Returns {sequence, fragments} or throws. */
    async send(bytes, destination) {
      const hex = crc32(bytes).toString(16).padStart(8, "0");
      const lines = await this.request(`MODEMSEND ${bytes.length} ${destination} ${hex}`, (l) => l.startsWith("MODEMSENT") || l.startsWith("ERR"), 20000, bytes);
      const last = lines[lines.length - 1];
      if (last.startsWith("ERR")) throw new ProtocolError(last.replace(/^ERR /, ""));
      const f = last.split(/\s+/);
      return { sequence: +f[1], fragments: +f[3] };
    }
    async stats() {
      const lines = await this.request("MODEMSTATS", (l) => l.startsWith("MODEMSTATS") || l.startsWith("ERR"), 3000);
      const o = {};
      for (const kv of lines[lines.length - 1].split(/\s+/).slice(1)) { const [k, v] = kv.split("="); o[k] = v; }
      return o;
    }
    close() { this.running = false; }
  }
  /** USB Serial/JTAG: reset the chip so that it boots from its flash (esptool's hard reset for this port). */
  async function hardReset(port) {
    await port.setSignals({ dataTerminalReady: false, requestToSend: true });
    await sleep(100);
    await port.setSignals({ dataTerminalReady: false, requestToSend: false });
  }

  // ---------------------------------------------------------------- ROM loader (esptool load-ram --no-stub over USB Serial/JTAG)
  const ROM = { SYNC: 0x08, MEM_BEGIN: 0x05, MEM_END: 0x06, MEM_DATA: 0x07, READ_REG: 0x0a };
  const RAM_BLOCK = 0x1800;
  function slip(packet) {
    const out = [0xc0];
    for (const b of packet) {
      if (b === 0xc0) out.push(0xdb, 0xdc);
      else if (b === 0xdb) out.push(0xdb, 0xdd);
      else out.push(b);
    }
    out.push(0xc0);
    return new Uint8Array(out);
  }
  function romPacket(op, data, chk = 0) {
    const p = new Uint8Array(8 + data.length);
    p[0] = 0; p[1] = op; p[2] = data.length & 0xff; p[3] = data.length >> 8;
    p[4] = chk & 0xff; p[5] = (chk >> 8) & 0xff; p[6] = (chk >> 16) & 0xff; p[7] = (chk >>> 24) & 0xff;
    p.set(data, 8);
    return slip(p);
  }
  const u32s = (...v) => { const b = new Uint8Array(4 * v.length); v.forEach((x, i) => { b[4 * i] = x & 0xff; b[4 * i + 1] = (x >>> 8) & 0xff; b[4 * i + 2] = (x >>> 16) & 0xff; b[4 * i + 3] = (x >>> 24) & 0xff; }); return b; };

  /** Reads SLIP frames from the pipe until one answers `op`; returns {value, data}. */
  async function romResponse(pipe, op, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (!(await pipe.want(1, 50))) continue;
      const d = pipe.data();
      const s = d.indexOf(0xc0);
      if (s < 0) { pipe.clear(); continue; }
      const e = d.indexOf(0xc0, s + 1);
      if (e < 0) { await pipe.want(pipe.len + 1, 50); continue; }
      const raw = [];
      for (let i = s + 1; i < e; i++) {
        if (d[i] === 0xdb) { raw.push(d[i + 1] === 0xdc ? 0xc0 : 0xdb); i++; } else raw.push(d[i]);
      }
      pipe.drop(e + (e === s + 1 ? 0 : 1));
      if (raw.length < 8 || raw[0] !== 1 || raw[1] !== op) continue;
      const size = raw[2] | (raw[3] << 8);
      return { value: le32(raw, 4), data: raw.slice(8, 8 + size) };
    }
    throw new ProtocolError(`the ROM loader did not answer command 0x${op.toString(16)}`);
  }
  async function romCommand(pipe, op, data, chk = 0, ms = 3000, what = "") {
    await pipe.write(romPacket(op, data, chk));
    const r = await romResponse(pipe, op, ms);
    if (r.data.length >= 2 && r.data[0] !== 0) throw new ProtocolError(`the ROM loader refused ${what || "command 0x" + op.toString(16)} (error 0x${r.data[1].toString(16)})`);
    return r;
  }
  /** The segments and entry of an ESP image (.bin made by esptool elf2image). */
  function parseImage(bin) {
    if (bin[0] !== 0xe9) throw new Error("not an ESP image (magic byte)");
    const count = bin[1], entry = le32(bin, 4);
    let o = 8 + 16;                                 // common header + extended header (ESP32-S3)
    const segs = [];
    for (let i = 0; i < count; i++) {
      const addr = le32(bin, o), len = le32(bin, o + 4);
      segs.push({ addr, data: bin.subarray(o + 8, o + 8 + len) });
      o += 8 + len;
    }
    return { entry, segs };
  }
  /** USB Serial/JTAG: reset into the ROM loader (esptool's usb-reset), then sync. Pass a Pipe on an open port; port must support setSignals. */
  async function romEnter(port, pipe, log = () => {}) {
    const sig = (dtr, rts) => port.setSignals({ dataTerminalReady: dtr, requestToSend: rts });
    await sig(false, false); await sleep(100);
    await sig(true, false); await sleep(100);
    await port.setSignals({ requestToSend: true }); await port.setSignals({ dataTerminalReady: false }); await port.setSignals({ requestToSend: true });
    await sleep(100);
    await sig(false, false);
    await sleep(300);
    pipe.clear();
    const syncData = new Uint8Array([0x07, 0x07, 0x12, 0x20, ...new Array(32).fill(0x55)]);
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        await pipe.write(romPacket(ROM.SYNC, syncData));
        await romResponse(pipe, ROM.SYNC, 150);
        await sleep(50);
        pipe.clear();
        return true;
      } catch (e) {
        log(`sync attempt ${attempt + 1} ...`);
      }
    }
    throw new ProtocolError("the chip did not enter its ROM loader");
  }
  /** load-ram: every segment into RAM, then run from the entry point. */
  async function romLoadRam(pipe, bin, progress = () => {}) {
    const { entry, segs } = parseImage(bin);
    const total = segs.reduce((a, s) => a + s.data.length, 0);
    let done = 0;
    for (const s of segs) {
      const blocks = Math.ceil(s.data.length / RAM_BLOCK);
      await romCommand(pipe, ROM.MEM_BEGIN, u32s(s.data.length, blocks, RAM_BLOCK, s.addr), 0, 3000, "MEM_BEGIN");
      for (let b = 0; b < blocks; b++) {
        const chunk = s.data.subarray(b * RAM_BLOCK, Math.min(s.data.length, (b + 1) * RAM_BLOCK));
        let chk = 0xef;
        for (const x of chunk) chk ^= x;
        const pkt = new Uint8Array(16 + chunk.length);
        pkt.set(u32s(chunk.length, b, 0, 0));
        pkt.set(chunk, 16);
        await romCommand(pipe, ROM.MEM_DATA, pkt, chk, 3000, "MEM_DATA");
        done += chunk.length;
        progress(done / total);
      }
    }
    await pipe.write(romPacket(ROM.MEM_END, u32s(entry === 0 ? 1 : 0, entry)));
    try { await romResponse(pipe, ROM.MEM_END, 300); } catch (e) { /* the image may already run */ }
  }

  const api = { sleep, crc32, fft, whiteningSequence, crc16, frameSymbols, frameTrack, symbolsPerFrame, frameSamples, upchirp, demodulate, demodulateAll, mix,
    coarseCentre, toChipRate, firwin, RxDecoder, OP, Pipe, Link, ProtocolError, FAIL_NAMES, STATUS_NAMES, configureReceiver, runReceiver, gainDbToSel, RX_RATE,
    peakCode, loWord, wordHz, loraPlan, loraRecords, transmit, TX_MIN_HZ, TX_MAX_HZ, RANGE_DB, parseImage, romEnter, romLoadRam, Lora32, hardReset };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.EspCore = api;
})(typeof self !== "undefined" ? self : this);
