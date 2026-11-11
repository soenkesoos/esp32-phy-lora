// LoRa from one board to another through webui/core.js (no browser): both boards run the esp32-sdr-trx SDR firmware.
// Environment: RXP / TXP (ports; default usbmodem11201 receives, usbmodem11101 sends), SF (7), CR (1 = 4/5 .. 4 = 4/8), PWR (transmit dB, -17),
// GAIN (receive dB, -30 .. 49.6), PPM_TX (sender's crystal correction, frequency and chirp timing), GAP / TAIL (ms), SAVE (recording, complex float32).
// usage: SF=9 CR=4 PWR=0 GAIN=0 PPM_TX=-39.8 node tests/hw/sdr_link.js
const C = require(require("path").join(__dirname, "..", "..", "webui", "core.js"));
const shim = require("./webserial-shim.js");
async function connect(path) { const p = shim(path); await p.open({ baudRate: 115200 }); const pipe = new C.Pipe(p); await pipe.start(); return { port: p, pipe, link: new C.Link(pipe) }; }
(async () => {
  const rx = await connect(process.env.RXP || "/dev/cu.usbmodem11201"), tx = await connect(process.env.TXP || "/dev/cu.usbmodem11101");
  console.log("rx info", await rx.link.info(), "tx info", await tx.link.info());
  const w = tx.pipe.write.bind(tx.pipe);
  tx.pipe.write = async (b) => { const t = Date.now(); await w(b); if (b.length > 10) console.log("  wrote", b.length, "bytes in", Date.now() - t, "ms"); };
  const freq = 2350e6;
  const lo = await C.configureReceiver(rx.link, freq, C.gainDbToSel(Number(process.env.GAIN || 10)));
  console.log("rx LO", lo);
  const dec = new C.RxDecoder(C.RX_RATE, +(process.env.SF || 7), 62500);
  let stop = false, nS = 0; const frames = [], chunks = [];
  const run = C.runReceiver(rx.link, (re, im) => { nS += re.length; chunks.push([re, im]); }, () => stop);
  await C.sleep(800);
  const plan = C.loraPlan(freq + 50e3, 62500, +(process.env.PPM_TX || 0));
  console.log("tx plan", plan);
  for (let k = 0; k < 4; k++) {
    const rec = C.loraRecords(new TextEncoder().encode("NODE TEST " + k), +(process.env.SF || 7), 62500, +(process.env.CR || 1), +(process.env.PWR || -17), plan);
    const t1 = Date.now(); const evs = []; const sum = await C.transmit(tx.link, plan, rec, (ev) => evs.push(ev.fill + (ev.carrier ? "c" : ""))); console.log("records", rec.length, "ms", Date.now() - t1, "status", evs.slice(0, 12).join(" "), "...", evs.length);
    console.log("tx", k, sum);
    await C.sleep(+(process.env.GAP || 700));
  }
  await C.sleep(+(process.env.TAIL || 1000)); stop = true;
  const r = await run;
  console.log("rx run", r.status, r.value, r.stats, "samples", nS);
  { const n = chunks.reduce((a, c) => a + c[0].length, 0), f = new Float32Array(2 * n); let k = 0;
    for (const [re, im] of chunks) for (let i = 0; i < re.length; i++) { f[k++] = re[i]; f[k++] = im[i]; }
    require("fs").writeFileSync(process.env.SAVE || "cap.f32", Buffer.from(f.buffer)); }
  for (const [re, im] of chunks) { dec.push(re, im); frames.push(...dec.process()); }
  for (const f of frames) console.log("FRAME", new TextDecoder().decode(f.payload), f.crcOk, (f.shiftHz / 1e3).toFixed(1) + " kHz", "snr " + f.snrDb.toFixed(1));
  await rx.pipe.close(); await tx.pipe.close(); await rx.port.close(); await tx.port.close();
  process.exit(0);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
