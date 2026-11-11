// Drives esp-lora-console.html in headless Chrome against the real boards: navigator.serial is replaced by ports bridged to node's serialport.
// usage: PATHS=/dev/cu.usbmodemA,/dev/cu.usbmodemB OUT=. node tests/page/run.js tests/page/<steps>.js
const puppeteer = require("puppeteer");
const { SerialPort } = require("serialport");
const OUT = process.env.OUT || ".";
const PATHS = (process.env.PATHS || "/dev/cu.usbmodem11201,/dev/cu.usbmodem11101").split(",");
(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ["--allow-file-access-from-files"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1320, height: 1250 });
  const ports = {};
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  let pend = {};
  setInterval(() => {                                    // batch incoming bytes to the page every 10 ms
    for (const [id, chunks] of Object.entries(pend)) {
      if (!chunks.length) continue;
      const b64 = Buffer.concat(chunks).toString("base64"); pend[id] = [];
      page.evaluate((id, b64) => window.__serialData(+id, b64), id, b64).catch(() => {});
    }
  }, 10);
  await page.exposeFunction("__nodeOpen", (id) => new Promise((res, rej) => {
    const sp = new SerialPort({ path: PATHS[id], baudRate: 115200, autoOpen: false, hupcl: false });
    sp.open((e) => { if (e) return rej(e.message); ports[id] = sp; pend[id] = []; sp.on("data", (d) => pend[id].push(d)); res(true); });
  }));
  await page.exposeFunction("__nodeWrite", (id, b64) => new Promise((res, rej) => ports[id].write(Buffer.from(b64, "base64"), (e) => (e ? rej(e.message) : ports[id].drain(() => res(true))))));
  await page.exposeFunction("__nodeSignals", (id, s) => new Promise((res, rej) => {
    const o = {}; if ("dataTerminalReady" in s) o.dtr = s.dataTerminalReady; if ("requestToSend" in s) o.rts = s.requestToSend;
    ports[id].set(o, (e) => (e ? rej(e.message) : res(true)));
  }));
  await page.exposeFunction("__nodeClose", (id) => new Promise((res) => ports[id].close(() => res(true))));
  await page.evaluateOnNewDocument((n) => {
    const ctl = {};
    window.__serialData = (id, b64) => { const s = atob(b64), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); ctl[id]?.enqueue(u); };
    const b64 = (u) => { let s = ""; for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode.apply(null, u.subarray(i, i + 8192)); return btoa(s); };
    class FakePort {
      constructor(id) { this.id = id; }
      getInfo() { return { usbVendorId: 0x303a, usbProductId: 0x1001 }; }
      async open() {
        await window.__nodeOpen(this.id);
        const id = this.id;
        this.readable = new ReadableStream({ start(c) { ctl[id] = c; } });
        this.writable = new WritableStream({ write: (chunk) => window.__nodeWrite(id, b64(new Uint8Array(chunk))) });
      }
      setSignals(s) { return window.__nodeSignals(this.id, s); }
      async close() { await window.__nodeClose(this.id); }
    }
    const list = Array.from({ length: n }, (_, i) => new FakePort(i));
    Object.defineProperty(navigator, "serial", { value: { getPorts: async () => list, requestPort: async () => list[0], addEventListener() {} } });
  }, PATHS.length);
  await page.goto("file://" + require("path").resolve(__dirname, "..", "..", "esp-lora-console.html"));
  await require(require("path").resolve(process.argv[2]))(page, OUT, errors, browser);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
