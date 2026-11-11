const C = require(require("path").join(__dirname, "..", "..", "webui", "core.js"));
const shim = require("./webserial-shim.js");
(async () => {
  const boards = [];
  for (const [path, node] of [["/dev/cu.usbmodem11201", 1], ["/dev/cu.usbmodem11101", 2]]) {
    const p = shim(path); await p.open({ baudRate: 115200 }); const pipe = new C.Pipe(p); await pipe.start();
    let sdr = null; try { sdr = await new C.Link(pipe).info(800); } catch (e) {}
    pipe.clear();
    const rx = [];
    const m = new C.Lora32(pipe, (r) => rx.push(r));
    const id = await m.sync();
    await m.start(node, true);
    console.log(path, "sdr-trx probe:", sdr ? "yes" : "no", "| LORA32:", id, "| node", node);
    boards.push({ m, rx, node, p, pipe });
  }
  const enc = new TextEncoder(), dec = new TextDecoder();
  for (const [a, b, dest] of [[0, 1, 255], [1, 0, 255], [0, 1, 2], [1, 0, 1]]) {
    const r = await boards[a].m.send(enc.encode(`web core test from ${boards[a].node} to ${dest}`), dest);
    await C.sleep(800);
    console.log(`node ${boards[a].node} -> ${dest}: sent seq ${r.sequence}; node ${boards[b].node} got`, boards[b].rx.splice(0).map((x) => `${dec.decode(x.bytes)} (from ${x.source}, crc ${x.ok ? "ok" : "BAD"})`));
  }
  console.log("stats node 1:", JSON.stringify(await boards[0].m.stats()).slice(0, 160));
  process.exit(0);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
