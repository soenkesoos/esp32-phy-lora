"""Receive-gain sweep over the LORA32 link: the sender broadcasts N messages per step, the receiver's manual gain code goes down until nothing arrives.
usage: lora32_sweep.py SENDER_PORT RECEIVER_PORT [N] [codes...]"""
import sys, time, zlib, serial


class M:
    def __init__(s, port):
        s.s = serial.Serial(port, 115200, timeout=0.05); s.buf = b""; s.rx = []

    def pump(s, t):
        end = time.time() + t; out = []
        while time.time() < end:
            s.buf += s.s.read(4096)
            while b"\n" in s.buf:
                l, s.buf = s.buf.split(b"\n", 1); l = l.strip(b"\r").decode(errors="replace")
                (s.rx if l.startswith("MODEMRX") else out).append(l)
        return out

    def cmd(s, c, done=lambda l: l.startswith(("OK", "ERR")), t=4.0):
        s.s.write((c + "\n").encode()); got = []; end = time.time() + t
        while time.time() < end:
            got += s.pump(0.05)
            if got and done(got[-1]): break
        return got

    def setup(s, node, gain):
        s.s.write(b"\n"); time.sleep(0.2); s.pump(0.3)
        s.cmd("SYNC 777", done=lambda l: "777" in l)
        for c in ("MODEMOFF", "FREQ 2437", f"GAINMANUAL {gain}", "MODEMPHY LORA7", f"MODEMCONF {node} 255 1 1", "MODEMREL 0", "MODEMACKDROP 0", "MODEMON"):
            r = s.cmd(c)
            if not r or not r[-1].startswith("OK"): raise SystemExit(f"{c}: {r}")

    def send(s, p):
        s.s.write(f"MODEMSEND {len(p)} 255 {zlib.crc32(p) & 0xffffffff:08x}\n".encode()); got = []; end = time.time() + 3
        while time.time() < end and not any(l.startswith(("READY", "ERR")) for l in got): got += s.pump(0.02)
        s.s.write(p); end = time.time() + 6
        while time.time() < end and not any(l.startswith(("MODEMSENT", "ERR")) for l in got): got += s.pump(0.05)
        return got[-1] if got else ""

    def stats(s):
        l = [x for x in s.cmd("MODEMSTATS", done=lambda l: l.startswith(("MODEMSTATS", "ERR"))) if x.startswith("MODEMSTATS")]
        return dict(kv.split("=") for kv in l[0].split()[1:]) if l else {}


tx, rx = M(sys.argv[1]), M(sys.argv[2])
N = int(sys.argv[3]) if len(sys.argv) > 3 else 20
codes = [int(c) for c in sys.argv[4:]] or [82, 75, 65, 55, 45, 40, 35, 30, 25, 20, 15, 10, 5, 0]
tx.setup(2, 65); rx.setup(1, codes[0])
print("GAIN? on receiver:", rx.cmd("GAIN?", done=lambda l: l.startswith(("GAIN ", "ERR")))[-1:])
for g in codes:
    for c in ("MODEMOFF", f"GAINMANUAL {g}", "MODEMON"): rx.cmd(c)
    rx.pump(0.3); rx.rx.clear(); s0 = rx.stats()
    for i in range(N):
        tx.send(f"g{g:02d} n{i:02d} xxxxxxxxxx".encode()); rx.pump(0.25)
    rx.pump(0.8); s1 = rx.stats()
    got = {bytes.fromhex(l.split()[6]).decode(errors="replace") for l in rx.rx}
    ok = sum(1 for i in range(N) if f"g{g:02d} n{i:02d} xxxxxxxxxx" in got)
    d = lambda k: int(s1.get(k, 0)) - int(s0.get(k, 0))
    print(f"gain code {g:3d}: {ok:2d}/{N} received   syncs +{d('syncs')}, header fails +{d('header_fail')}, CRC fails +{d('crc_fail')}, last symbol quality {s1.get('quality')}", flush=True)
rx.cmd("MODEMOFF"); rx.cmd("GAINMANUAL 65"); rx.cmd("MODEMON")
