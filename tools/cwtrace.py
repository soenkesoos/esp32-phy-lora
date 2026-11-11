"""Frequency of a received carrier over time (1 ms steps), to find steps or jumps. Runs a sender command meanwhile.
usage: cwtrace.py SDR_PORT TUNE_MHZ GAIN SHIFT SECONDS -- sender command ..."""
import os, sys, time, subprocess
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "esp32-sdr-trx", "src"))
from espdr import nb  # noqa: E402

FS = 250e3
port, tune, gain, shift, seconds = sys.argv[1], float(sys.argv[2]) * 1e6, int(sys.argv[3]), int(sys.argv[4]), float(sys.argv[5])
cmd = sys.argv[sys.argv.index("--") + 1:]
link = nb.open_link(port)
nb.check_firmware(link)
nb.configure_receiver(link, tune, 4, 1, shift, gain)
parts, firsts = [], []
proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
t0 = time.monotonic()
st, val, stats = link.run(0, lambda h, p: (parts.append(np.frombuffer(p, np.int8)), firsts.append((h["first"], h["count"]))), stop_flag=lambda: time.monotonic() - t0 > seconds)
proc.wait(timeout=30)
gaps = sum(1 for (a, n), (b, _) in zip(firsts, firsts[1:]) if b != (a + n) & 0xFFFFFFFF)
slips = link.stat(nb.NB_STAT_SLIPS)
a = np.concatenate(parts).astype(np.float32)
x = (a[0::2] - 1j * a[1::2])                         # conjugated: a higher RF is a higher frequency
x = x - x.mean()
amp = np.abs(x)
on = amp > 0.3 * np.percentile(amp, 99)
idx = np.flatnonzero(on)
x = x[idx[0] + 2500: idx[-1] - 2500]                  # the carrier only, 10 ms in from either end
# frequency per 1 ms from the phase of the lag-1 product (needs the tone near the centre: estimate it first)
f0 = np.angle(np.sum(x[1:] * np.conj(x[:-1]))) * FS / (2 * np.pi)
y = x * np.exp(-2j * np.pi * f0 * np.arange(len(x)) / FS)
blk = 250
n = len(y) // blk
ph = np.unwrap(np.angle(y[:n * blk].reshape(n, blk).sum(axis=1)))
f = np.diff(ph) * FS / blk / (2 * np.pi)              # Hz relative to f0, per 1 ms
t = np.arange(len(f)) / 1000
print(f"carrier at {f0 / 1e3:+.2f} kHz from the tuning; {len(f)} ms traced; packet gaps {gaps}; receiver slips (stat) {slips}; lost {stats['lost']}")
sm = np.convolve(f, np.ones(10) / 10, mode="valid")     # 10 ms average
print("frequency, 10 ms averages every 100 ms (Hz):", " ".join(f"{v:+.0f}" for v in sm[::100]))
print(f"short-term jitter (1 ms, after removing the 10 ms average): rms {np.std(f[:len(sm)] - sm):.1f} Hz")
d = np.abs(np.diff(sm[::10]))
big = np.flatnonzero(d > 40)
print("steps > 40 Hz between consecutive 10 ms averages at", ", ".join(f"{(i + 1) * 10} ms ({d[i]:.0f} Hz)" for i in big[:15]) or "none")
print(f"drift over the trace: {sm[-1] - sm[0]:+.0f} Hz in {len(sm) / 1000:.2f} s")
