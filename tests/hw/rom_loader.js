const C = require(require("path").join(__dirname, "..", "..", "webui", "core.js"));
const shim = require("./webserial-shim.js");
const fs = require("fs");
(async () => {
  const path = "/dev/cu.usbmodem11101";
  const bin = new Uint8Array(fs.readFileSync(require("path").join(__dirname, "..", "..", "esp32-sdr-trx", "firmware", "build-tx", "iq-source.bin")));
  console.log("segments", C.parseImage(bin).segs.map(s => s.addr.toString(16) + ":" + s.data.length).join(" "));
  let p = shim(path); await p.open({ baudRate: 115200 });
  let pipe = new C.Pipe(p); await pipe.start();
  const t0 = Date.now();
  await C.romEnter(p, pipe, console.log);
  console.log("in ROM after", Date.now() - t0, "ms");
  let last = 0;
  await C.romLoadRam(pipe, bin, (f) => { if (f - last > 0.25 || f === 1) { console.log("  loaded", Math.round(100 * f) + "%"); last = f; } });
  console.log("loaded after", Date.now() - t0, "ms");
  await C.sleep(1500);
  pipe.clear();
  let info;
  try { info = await new C.Link(pipe).info(); } catch (e) { console.log("same port object:", e.message); }
  if (!info) {   // the port may have re-enumerated: reopen
    try { await pipe.close(); await p.close(); } catch (e) {}
    p = shim(path); await p.open({ baudRate: 115200 }); pipe = new C.Pipe(p); await pipe.start();
    info = await new C.Link(pipe).info();
    console.log("after reopen");
  }
  console.log("firmware info", info);
  process.exit(0);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
