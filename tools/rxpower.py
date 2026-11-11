"""Received power of whatever the other board sends, measured with the esp32-sdr-trx SDR firmware at a fixed gain.
Records a 250 ksps slice while a sender command runs, and reports the band power (5..90 kHz either side, no DC) during the transmission and
without it, in dB relative to one int8 count^2 at output shift 4 (so different shifts compare).
usage: rxpower.py SDR_PORT TUNE_MHZ GAIN SHIFT SECONDS -- sender command ..."""
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
parts = []
proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
t0 = time.monotonic()
link.run(0, lambda h, p: parts.append(np.frombuffer(p, np.int8)), stop_flag=lambda: time.monotonic() - t0 > seconds)
proc.wait(timeout=30)
a = np.concatenate(parts).astype(np.float32)
x = a[0::2] + 1j * a[1::2]
clip = np.mean((np.abs(x.real) >= 126) | (np.abs(x.imag) >= 126))
x = x - x.mean()
blk = 64
n = len(x) // blk
f = np.fft.fftfreq(blk, 1 / FS)
keep = (np.abs(f) > 5e3) & (np.abs(f) < 90e3)
w = np.hanning(blk)
P = (np.abs(np.fft.fft(x[:n * blk].reshape(n, blk) * w, axis=1)) ** 2)[:, keep].sum(axis=1) / np.sum(w ** 2)   # power in the band, per block
noise = np.percentile(P, 10)
on = P > 8 * noise
ref = 6.02 * (shift - 4)
db = lambda v: 10 * np.log10(v) + ref
print(f"clip {100 * clip:.2f} %, noise {db(noise):.1f} dB, signal blocks {on.mean() * 100:.0f} %, band power while sending (median) {db(np.median(P[on])) if on.any() else float('nan'):.1f} dB"
      f" -> above noise {10 * np.log10(np.median(P[on]) / noise) if on.any() else float('nan'):.1f} dB")
