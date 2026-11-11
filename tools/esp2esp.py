#!/usr/bin/env python3
"""RESEARCH ONLY: narrow LoRa from one ESP32-S3 to another, no PlutoSDR. The receiving board (native USB port) runs espdr-rx at 250 ksps behind its
rtl_tcp bridge; the transmitting board (native USB port too) sends `espdr-tx -m lora` frames; the numpy receiver decodes the recording. Both boards
must already run their firmware (load each with `python -m esptool --chip esp32s3 --port PORT --before usb-reset --after no-reset --no-stub load-ram
firmware/build-rx/iq-source.bin`, or build-tx): the tools' own loader expects one board at a time. TRANSMITS inside the 13 cm band (needs a transmit
permission, or a shielded room).

    tools/esp2esp.py --rx-port /dev/cu.usbmodem11201 --tx-port /dev/cu.usbmodem11101 --sf 7 --count 6
"""
import argparse
import os
import socket
import struct
import subprocess
import sys
import threading
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "esp32-sdr-trx"))
sys.path.insert(0, os.path.join(ROOT, "src"))
from espdr import lora_phy as lp  # noqa: E402

FS = 250e3
ENV = dict(os.environ, PYTHONPATH=os.path.join(ROOT, "src") + os.pathsep + os.environ.get("PYTHONPATH", ""))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rx-port", required=True, help="native USB port of the receiving board")
    ap.add_argument("--tx-port", required=True, help="native USB port of the transmitting board")
    ap.add_argument("--sf", type=int, default=7)
    ap.add_argument("--bw", type=float, default=62500.0)
    ap.add_argument("--cr", type=int, default=1)
    ap.add_argument("--text", default="ESP2ESP LORA")
    ap.add_argument("--freq", type=float, default=2350.0, help="receiver's tuning, MHz")
    ap.add_argument("--offset", type=float, default=50e3, help="transmitter's centre above the receiver's tuning, Hz (keeps the frame off DC)")
    ap.add_argument("--count", type=int, default=6, help="frames to send")
    ap.add_argument("--interval", type=float, default=1.0, help="seconds between frames (at least 1)")
    ap.add_argument("--power", type=float, default=-20.0, help="espdr-tx --power, dB below the strongest (the boards are close)")
    ap.add_argument("--gain", type=float, default=30.0, help="rtl_tcp gain of the receiver, dB")
    ap.add_argument("--span", type=float, default=110e3, help="search for the frame's centre over +- this, Hz (both crystals, and espdr-tx's own move)")
    ap.add_argument("--save", help="save the recording (.npz)")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    rx = subprocess.Popen([sys.executable, "-m", "espdr.cli_rx", "--listen", "127.0.0.1:1234", "--ppm", "0", "--no-load", "--port", args.rx_port],
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=ENV)
    threading.Thread(target=lambda: [print("rx |", line.rstrip(), flush=True) for line in rx.stdout], daemon=True).start()
    data = bytearray()
    try:
        s = None
        for _ in range(60):
            if rx.poll() is not None:
                raise SystemExit("espdr-rx ended")
            try:
                s = socket.create_connection(("127.0.0.1", 1234), timeout=2)
                break
            except OSError:
                time.sleep(1.0)
        if s is None:
            raise SystemExit("the espdr-rx server did not come up")
        s.settimeout(0.5)
        s.recv(12)
        for cmd, val in ((0x02, int(FS)), (0x01, int(args.freq * 1e6)), (0x03, 1), (0x04, int(args.gain * 10))):
            s.sendall(struct.pack(">BI", cmd, val))

        stop = threading.Event()

        def record():
            while not stop.is_set():
                try:
                    chunk = s.recv(65536)
                except socket.timeout:
                    continue
                if not chunk:
                    break
                data.extend(chunk)

        th = threading.Thread(target=record)
        th.start()
        time.sleep(1.0)
        tx_cmd = [sys.executable, "-m", "espdr.cli_tx", "--accept-licence", "-m", "lora", "-f", f"{args.freq + args.offset / 1e6:.6f}",
                  "--text", args.text, "--sf", str(args.sf), "--lora-bw", str(args.bw), "--lora-cr", str(args.cr),
                  "--repeat-count", str(args.count), "--repeat-interval", str(max(1.0, args.interval)), "--power", str(args.power), "--thermal", "off"]
        tx_cmd += ["--no-load", "--port", args.tx_port]
        if args.verbose:
            tx_cmd.append("-v")
        print("tx |", " ".join(tx_cmd[2:]), flush=True)
        t0 = time.monotonic()
        rc = subprocess.call(tx_cmd, env=ENV)
        print(f"espdr-tx ended with {rc} after {time.monotonic() - t0:.1f} s", flush=True)
        time.sleep(0.5)
        stop.set()
        th.join()
    finally:
        rx.terminate()
        try:
            rx.wait(timeout=5)
        except Exception:  # noqa: BLE001
            rx.kill()

    raw = np.frombuffer(bytes(data[: len(data) // 2 * 2]), np.uint8).astype(np.float32) - 127.5
    x = (raw[0::2] + 1j * raw[1::2]).astype(np.complex64)
    print(f"received {len(x)} samples = {len(x) / FS:.1f} s; rms {np.sqrt(np.mean(np.abs(x - x.mean()) ** 2)):.1f} counts, peak {np.abs(x).max():.0f}")
    if args.save:
        np.savez_compressed(args.save, x=x, fs=FS)
    if not len(x):
        return 1
    c0 = lp.coarse_centre(x, FS, args.bw)
    print(f"strongest band in the spectrum at {c0 / 1e3:+.1f} kHz from the receiver's tuning")
    frames, c, good = lp.search_centre(x, FS, args.bw, args.sf, args.text.encode(), span=args.span)
    for f in frames:
        print("  frame:", {k: f.get(k) for k in ("payload", "crc_ok", "cfo", "snr") if k in f})
    print(f"RESULT: {good} of {args.count} frames decoded with the right bytes and CRC (signal at {c / 1e3:+.1f} kHz, SF{args.sf}, BW {args.bw / 1e3:g} kHz)")
    return 0 if good else 1


if __name__ == "__main__":
    sys.exit(main())
