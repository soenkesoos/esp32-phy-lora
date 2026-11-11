const C = require(require("path").join(__dirname, "..", "webui", "core.js"));
const fs = require("fs");
const D = process.argv[2] || require("path").join(__dirname, "fixtures");
const ref = JSON.parse(fs.readFileSync(D + "/ref.json"));
const p = Buffer.from("Hello ESP32 LoRa!");
let ok = true;
for (const key of Object.keys(ref)) {
  if (key === "codes") continue;
  const [sf, cr] = key.split("_").map(Number);
  const s = C.frameSymbols(p, sf, cr);
  const symOk = JSON.stringify(s) === JSON.stringify(ref[key].syms);
  const t = C.frameTrack(p, sf, 62500, 40000, cr);
  let maxd = 0; ref[key].track.forEach((v, i) => maxd = Math.max(maxd, Math.abs(v - t[i])));
  console.log(`SF${sf} CR${cr}: symbols ${symOk ? "same" : "DIFFER"}, track max diff ${maxd.toExponential(2)} Hz`);
  ok = ok && symOk && maxd < 1e-6;
}
const codes = [0, -3, -6, -12, -17.9].map(C.peakCode);
console.log("peak codes", codes, "python", ref.codes); ok = ok && JSON.stringify(codes) === JSON.stringify(ref.codes);
// loopback: encode as IQ at 250 ksps from the track's phase, add noise and an offset, decode
for (const sf of [7, 9]) {
  const bw = 62500, fs = 250000;
  const tr = C.frameTrack(p, sf, bw, fs, 1);
  const pad = 20000, n = tr.length + 2 * pad, re = new Float64Array(n), im = new Float64Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const f = (i >= pad && i < pad + tr.length ? tr[i - pad] : 0) + 7300;
    if (i >= pad && i < pad + tr.length) { re[i] = 20 * Math.cos(ph); im[i] = 20 * Math.sin(ph); }
    ph += 2 * Math.PI * f / fs;
    re[i] += 8 * (Math.random() - 0.5); im[i] += 8 * (Math.random() - 0.5);
  }
  const r = C.demodulateAll(re, im, fs, sf, bw);
  console.log(`loopback SF${sf}:`, r.frames.map(f => [Buffer.from(f.payload || []).toString(), f.crcOk, f.cfoHz.toFixed(0)]));
  ok = ok && r.frames.length === 1 && r.frames[0].crcOk;
}
console.log(ok ? "ALL OK" : "FAILURES");
