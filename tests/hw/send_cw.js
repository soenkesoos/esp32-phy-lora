// Sends a plain carrier for SECONDS from a board running the esp32-sdr-trx firmware: polar transmitter, every record at offset 0, power DB.
// usage: node send_cw.js PORT FREQ_MHZ POWER_DB SECONDS
const C = require(require("path").join(__dirname, "..", "..", "webui", "core.js"));
const shim = require("./webserial-shim.js");
(async () => {
  const [path, mhz, db, secs] = process.argv.slice(2);
  const p = shim(path); await p.open({ baudRate: 115200 });
  const pipe = new C.Pipe(p); await pipe.start(); const link = new C.Link(pipe);
  await link.info();
  const plan = C.loraPlan(+mhz * 1e6, 62500);
  const code = C.peakCode(+db);
  const rec = new Uint32Array(Math.round(+secs * 40000)).fill((code << 16) >>> 0);
  const sum = await C.transmit(link, plan, rec);
  console.log("carrier", mhz, "MHz, power", db, "dB (gain code", code + "):", sum.text);
  process.exit(0);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
