"""Broadcasts LORA32 frames back to back for SECONDS. usage: lora32_send.py PORT SECONDS"""
import sys, time, zlib, serial

s = serial.Serial(sys.argv[1], 115200, timeout=0.05); buf = b""


def lines(t):
    global buf
    end = time.time() + t; out = []
    while time.time() < end:
        buf += s.read(4096)
        while b"\n" in buf:
            l, buf = buf.split(b"\n", 1); out.append(l.strip(b"\r").decode(errors="replace"))
    return out


def wait(prefixes, t):
    got = []; end = time.time() + t
    while time.time() < end and not any(l.startswith(prefixes) for l in got): got += lines(0.01)
    return got


s.write(b"\n"); time.sleep(0.2); lines(0.2)
s.write(b"SYNC 31\n"); lines(0.4)
for c in ("MODEMOFF", "FREQ 2437", "GAINMANUAL 65", "MODEMPHY LORA7", "MODEMCONF 2 255 1 1", "MODEMREL 0", "MODEMON"):
    s.write((c + "\n").encode()); wait(("OK", "ERR"), 3)
end = time.time() + float(sys.argv[2]); n = 0
while time.time() < end:
    p = f"POWER TEST {n:05d} padding padding padding".encode(); n += 1
    s.write(f"MODEMSEND {len(p)} 255 {zlib.crc32(p) & 0xffffffff:08x}\n".encode()); wait(("READY", "ERR"), 3)
    s.write(p); wait(("MODEMSENT", "ERR"), 5)
s.write(b"MODEMOFF\n"); wait(("OK", "ERR"), 3)
