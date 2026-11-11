#!/usr/bin/env python3
"""Builds the single offline page: app.html with core.js and the transmitter firmware (base64) inlined.

    python3 webui/build.py [firmware.bin] [-o esp-lora-console.html]
"""
import argparse
import base64
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
DEFAULT_FW = HERE.parent / "esp32-sdr-trx" / "firmware" / "build-tx" / "iq-source.bin"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("firmware", nargs="?", default=str(DEFAULT_FW), help="the TX=1 image (it receives too)")
    ap.add_argument("-o", "--out", default=str(HERE.parent / "esp-lora-console.html"))
    a = ap.parse_args()
    html = (HERE / "app.html").read_text()
    core = (HERE / "core.js").read_text()
    fw = base64.b64encode(pathlib.Path(a.firmware).read_bytes()).decode()
    assert "</script" not in core
    html = html.replace("/*CORE*/", core, 1).replace("/*FIRMWARE*/", fw, 1)
    pathlib.Path(a.out).write_text(html)
    print(f"{a.out}: {len(html) // 1024} KB (firmware {a.firmware}, {len(fw) * 3 // 4 // 1024} KB)")


if __name__ == "__main__":
    main()
