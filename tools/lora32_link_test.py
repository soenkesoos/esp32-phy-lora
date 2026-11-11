import serial, time, zlib, sys, threading
PORTS = {1: "/dev/cu.usbmodem11201", 2: "/dev/cu.usbmodem11101"}
class M:
    def __init__(s, port):
        s.s = serial.Serial(port, 115200, timeout=0.1); s.buf = b""; s.events = []
    def lines(s, t=1.0):
        end = time.time() + t; out = []
        while time.time() < end:
            s.buf += s.s.read(4096)
            while b"\n" in s.buf:
                l, s.buf = s.buf.split(b"\n", 1); l = l.strip(b"\r").decode(errors="replace")
                if l.startswith("MODEMRX"): s.events.append(l)
                out.append(l)
        return out
    def cmd(s, c, want=None, t=3.0):
        s.s.write((c + "\n").encode()); end = time.time() + t; got = []
        while time.time() < end:
            ls = s.lines(0.1); got += ls
            if any((want and l.startswith(want)) or l.startswith("OK") or l.startswith("ERR") for l in ls): break
        return [l for l in got if not l.startswith("MODEMRX")]
m = {k: M(p) for k, p in PORTS.items()}
for k, x in m.items():
    x.lines(0.5)
    print(k, "SYNC:", x.cmd("SYNC 4242", want="4242", t=2), "INFO:", x.cmd("INFO", want="S3SDR", t=2))
    for c in ("MODEMOFF", "FREQ 2437", "GAINMANUAL 65", "MODEMPHY LORA7", f"MODEMCONF {k} 255 1 1", "MODEMREL 0", "MODEMACKDROP 0", "MODEMON"):
        r = x.cmd(c); print("  ", c, "->", r[-1:] )
time.sleep(1)
for src, dst in ((1, 2), (2, 1)):
    for i in range(3):
        p = f"hello from node {src} #{i}".encode()
        x = m[src]; x.s.write(f"MODEMSEND {len(p)} 255 {zlib.crc32(p) & 0xffffffff:08x}\n".encode())
        r = []
        end = time.time() + 3
        while time.time() < end and not any(l.startswith("READY") or l.startswith("ERR") for l in r): r += x.lines(0.05)
        x.s.write(p)
        end = time.time() + 6
        while time.time() < end and not any(l.startswith("MODEMSENT") or l.startswith("ERR") for l in r): r += x.lines(0.1)
        print(f"node {src} send #{i}:", [l for l in r if l.startswith(("MODEMSENT", "ERR"))])
        m[dst].lines(1.0)
    ev = m[dst].events; m[dst].events = []
    print(f"node {dst} received:", [bytes.fromhex(e.split()[6]).decode(errors="replace") for e in ev])
for k, x in m.items(): print(k, x.cmd("MODEMSTATS", want="MODEMSTATS")[-2:])
