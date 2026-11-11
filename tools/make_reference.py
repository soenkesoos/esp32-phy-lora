#!/usr/bin/env python3
"""Writes tests/fixtures/ref.json: symbols and the polar transmitter's frequency track from esp32-sdr-trx's Python LoRa PHY (lora_phy.py)
and the power-to-gain-code table (txmodes.py), the reference that tests/test_modem.js checks webui/core.js against.
usage: .venv/bin/python tools/make_reference.py"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "esp32-sdr-trx", "src"))
from espdr import lora_phy as lp, txmodes  # noqa: E402

ref = {}
for sf in (5, 7, 8, 10):
    for cr in (1, 4):
        p = b"Hello ESP32 LoRa!"
        ref[f"{sf}_{cr}"] = dict(syms=lp.frame_symbols(p, sf, cr), track=lp.frame_track(p, sf, 62500, 40000, cr)[:3000].tolist())
ref["codes"] = [txmodes.peak_code(p) for p in (0, -3, -6, -12, -17.9)]
out = os.path.join(HERE, "..", "tests", "fixtures", "ref.json")
json.dump(ref, open(out, "w"))
print("wrote", os.path.normpath(out))
