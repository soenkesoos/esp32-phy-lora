"""SNR of the LORA32 signal (SF7, 1.25 MHz at 2439.5 MHz) at the other board, per receive gain code.

The sender (LORA32 firmware) broadcasts continuously; the receiver runs the esp32-sdr-trx SDR firmware (RAM) and records a 200 kHz slice of the
1.25 MHz channel at 250 ksps. The chirps spread their power evenly over the channel, so the ratio of the power density during frames to the power
density between frames, in the slice, is the SNR in the channel bandwidth (LoRa's definition). The output shift is raised until nothing clips.
usage: lora32_snr.py SENDER_PORT SDR_PORT gain_codes..."""
import sys, os, time, zlib, threading
import numpy as np
import serial

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "esp32-sdr-trx", "src"))
from espdr import nb  # noqa: E402

TUNE = 2439.30e6                   # inside the channel (2438.875 .. 2440.125 MHz) and 700 kHz away from the 2440.000 MHz crystal spur
FS = 250e3


def sender(port, stop):
    s = serial.Serial(port, 115200, timeout=0.05); buf = b""

    def lines(t):
        nonlocal buf
        end = time.time() + t; out = []
        while time.time() < end:
            buf += s.read(4096)
            while b"\n" in buf:
                l, buf = buf.split(b"\n", 1); out.append(l.strip(b"\r").decode(errors="replace"))
        return out

    def cmd(c, want=("OK", "ERR")):
        s.write((c + "\n").encode()); got = []; end = time.time() + 4
        while time.time() < end and not any(l.startswith(want) for l in got): got += lines(0.05)
        return got
    s.write(b"\n"); time.sleep(0.2); lines(0.2)
    s.write(b"SYNC 99\n"); lines(0.5)
    for c in ("MODEMOFF", "FREQ 2437", "GAINMANUAL 65", "MODEMPHY LORA7", "MODEMCONF 2 255 1 1", "MODEMREL 0", "MODEMON"): cmd(c)
    n = 0
    while not stop.is_set():
        p = f"SNR TEST {n:05d} padding padding padding".encode(); n += 1
        s.write(f"MODEMSEND {len(p)} 255 {zlib.crc32(p) & 0xffffffff:08x}\n".encode()); got = []; end = time.time() + 3
        while time.time() < end and not any(l.startswith(("READY", "ERR")) for l in got): got += lines(0.01)
        s.write(p); end = time.time() + 5
        while time.time() < end and not any(l.startswith(("MODEMSENT", "ERR")) for l in got): got += lines(0.02)
    sender.count = n
    cmd("MODEMOFF")


def capture(link, gain, shift, seconds=1.2):
    nb.configure_receiver(link, TUNE, 4, 1, shift, gain)
    parts = []
    t0 = time.monotonic()
    link.run(0, lambda h, p: parts.append(np.frombuffer(p, np.int8)), stop_flag=lambda: time.monotonic() - t0 > seconds)
    a = np.concatenate(parts).astype(np.float32)
    return a[0::2] + 1j * a[1::2]


def analyse(x):
    clip = np.mean((np.abs(x.real) >= 126) | (np.abs(x.imag) >= 126))
    x = x[int(0.1 * FS):] - np.mean(x)
    blk = 64                                              # 0.26 ms blocks: shorter than a frame (several ms), longer than a symbol (0.1 ms)
    n = len(x) // blk
    seg = x[:n * blk].reshape(n, blk)
    # band power from the spectrum of each block, without DC (LO leakage) and the slice's filter edges
    f = np.fft.fftfreq(blk, 1 / FS)
    keep = (np.abs(f) > 5e3) & (np.abs(f) < 90e3)
    P = (np.abs(np.fft.fft(seg * np.hanning(blk), axis=1)) ** 2)[:, keep].mean(axis=1)
    noise = np.percentile(P, 20)
    burst = P > 8 * noise
    if burst.sum() < 20:
        return dict(clip=clip, noise=float(noise), snr=None, bursts=int(burst.sum()), rms=float(np.sqrt(np.mean(np.abs(x) ** 2))))
    sig = np.median(P[burst])
    return dict(clip=clip, noise=float(noise), snr=float(10 * np.log10(max(sig - noise, 1e-9) / noise)), bursts=int(burst.sum()),
                rms=float(np.sqrt(np.mean(np.abs(x) ** 2))))


def main():
    sender_port, sdr_port = sys.argv[1], sys.argv[2]
    gains = [int(g) for g in sys.argv[3:]]
    stop = threading.Event()
    th = threading.Thread(target=sender, args=(sender_port, stop), daemon=True); th.start()
    time.sleep(3)
    link = nb.open_link(sdr_port)
    nb.check_firmware(link)
    print("gain code | shift | clip %  | noise (dB, rel.) | frame blocks | SNR in 1.25 MHz")
    for g in gains:
        for shift in range(4, 12):
            r = analyse(capture(link, g, shift))
            if r["clip"] < 0.0005: break
        noise_db = 10 * np.log10(r["noise"]) + 6.02 * (shift - 4)      # referred back to shift 4
        snr = "none found" if r["snr"] is None else f"{r['snr']:6.1f} dB"
        print(f"{g:9d} | {shift:5d} | {100 * r['clip']:6.2f} | {noise_db:16.1f} | {r['bursts']:12d} | {snr}", flush=True)
    stop.set(); th.join(10)
    print("frames sent:", getattr(sender, "count", "?"))


if __name__ == "__main__":
    main()
