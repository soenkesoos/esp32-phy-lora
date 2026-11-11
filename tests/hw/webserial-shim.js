// Makes a `serialport` SerialPort look like a Web Serial SerialPort (open/readable/writable/setSignals/close).
const { SerialPort } = require("serialport");
module.exports = function shim(path) {
  let sp;
  const port = {
    async open({ baudRate }) {
      sp = new SerialPort({ path, baudRate: baudRate || 115200, autoOpen: false, hupcl: false });
      await new Promise((res, rej) => sp.open((e) => (e ? rej(e) : res())));
      port.readable = new ReadableStream({
        start(c) { sp.on("data", (d) => c.enqueue(new Uint8Array(d))); sp.on("close", () => { try { c.close(); } catch (e) {} }); },
        cancel() {},
      });
      port.writable = new WritableStream({
        write(chunk) { return new Promise((res, rej) => sp.write(Buffer.from(chunk), (e) => (e ? rej(e) : sp.drain(() => res())))); },
      });
    },
    async setSignals(s) {
      const o = {};
      if ("dataTerminalReady" in s) o.dtr = s.dataTerminalReady;
      if ("requestToSend" in s) o.rts = s.requestToSend;
      await new Promise((res, rej) => sp.set(o, (e) => (e ? rej(e) : res())));
    },
    async close() { await new Promise((res) => sp.close(() => res())); },
  };
  return port;
};
