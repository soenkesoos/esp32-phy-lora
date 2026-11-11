const C = require(require("path").join(__dirname, "..", "webui", "core.js"));
const fs = require("fs");
const D = process.argv[2];
for (const [name, sf, sent] of [["sf7_run2", 7, 6], ["sf8_g10", 8, 5], ["sf9_g10", 9, 5], ["sf10_g10", 10, 5]]) {
  const raw = new Float32Array(fs.readFileSync(`${D}/${name}.f32`).buffer.slice(0));
  const n = raw.length / 2, re = new Float32Array(n), im = new Float32Array(n);
  for (let i = 0; i < n; i++) { re[i] = raw[2 * i]; im[i] = raw[2 * i + 1]; }
  const dec = new C.RxDecoder(250000, sf, 62500);
  const chunk = 62500, out = [];
  const t0 = Date.now();
  for (let i = 0; i < n; i += chunk) { dec.push(re.subarray(i, i + chunk), im.subarray(i, i + chunk)); out.push(...dec.process()); }
  const good = out.filter(f => f.crcOk && Buffer.from(f.payload).toString() === "ESP2ESP LORA").length;
  console.log(`${name}: ${good} of ${sent} good, ${out.length} frames reported, ${(Date.now() - t0) / 1000}s CPU for ${(n / 250000).toFixed(1)}s of signal; at`,
    out.map(f => `${f.t.toFixed(2)}s ${(f.shiftHz / 1e3).toFixed(1)}kHz snr ${f.snrDb.toFixed(1)} ${f.crcOk ? "ok" : "crc!"}`).join(", "));
}
