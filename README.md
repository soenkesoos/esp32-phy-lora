# esp32-phy-lora: LoRa from the ESP32-S3 Wi-Fi PHY, without a LoRa chip

Experiments in sending and receiving LoRa (chirp spread spectrum) between plain ESP32-S3 boards, using only the chip's own 2.4 GHz Wi-Fi radio,
and an offline web console to drive them. Two firmwares are covered:

| | **esp32-sdr-trx** (SDR firmware) | **LORA32** (modem firmware) |
|---|---|---|
| Where it runs | loaded into **RAM** by the console (flash untouched) | written to **flash** |
| Who does the LoRa | the console (JavaScript encoder/decoder) | the chip itself |
| Channel | 62.5 kHz at 2320–2450 MHz (13 cm amateur band) | 1.25 MHz at 2439.5 MHz (2.4 GHz ISM band) |
| Spreading factors | SF5–SF11 | SF7 only |
| Link margin (measured, boards 7 cm apart) | **~75–85 dB** (estimate from measured parts) | **~17 dB** |
| Range estimate, free space / indoors | SF9: ~600 m / ~30 m | ~0.5 m / ~0.3 m |

The SDR path is far better: more transmit power, a 20× narrower channel and a decoder close to an ideal LoRa receiver.
Everything measured, every fix and every dead end is in **[docs/FINDINGS.md](docs/FINDINGS.md)**.

## Quick start

1. Open **[esp-lora-console.html](esp-lora-console.html)** in **Chrome or Edge** (desktop). It works offline from the file; it needs the
   Web Serial API (Safari has none; Brave may need `brave://settings/content/serialPorts`).
2. Plug in the ESP32-S3 boards by their **native USB** port (`USB JTAG/serial debug unit`, 303a:1001) and press **+ Connect board** for each.
3. The console detects the firmware on each board:
   * **esp32-sdr-trx**: a card with *Receive* and *Transmit* tabs, spectrum, waterfall and a list of decoded frames.
   * **LORA32**: a modem card (node ID, send text/hex to a node or to everyone, received messages, statistics).
   * anything else: press **Load SDR firmware** (about 1 s, into RAM; the flash keeps what it has). **Reboot** returns to the flash firmware.
4. For a link with the SDR firmware: one board *Receive*, the other *Transmit*, the same SF and bandwidth on both. Leave
   **correct the sender's crystal** on: the first received frame sets the sender's crystal correction (needed for SF10 and SF11), and
   **automatic gain** keeps the receiver out of clipping.

Recommended for range: transmit power 0 dB, SF9 (or SF10/SF11 for more margin at a lower rate), 62.5 kHz, coding rate 4/5.

Transmitting on 2320–2450 MHz needs an amateur radio licence, or a shielded room. Neither firmware's spurious emissions have been measured.

## Layout

| Path | What |
|---|---|
| `esp-lora-console.html` | the built console: one file, firmware included (`python3 webui/build.py` rebuilds it) |
| `webui/core.js` | protocols and the LoRa PHY, without DOM: esp32-sdr-trx control/stream/transmit protocol, LORA32's line protocol, esptool's ROM loader (load-ram), LoRa encoder, polar-transmitter track, streaming decoder |
| `webui/app.html`, `webui/build.py` | the console's page and the build that inlines `core.js` and the SDR firmware image (base64) |
| `tools/` | Python measurement tools (gain sweeps, SNR, received power, carrier frequency trace, LORA32 link test, `esp2esp.py`) |
| `tests/` | `test_modem.js` (core.js against the Python reference), `test_recordings.js`, `hw/` (core.js on real boards through node-serialport), `page/` (the real page in headless Chrome with `navigator.serial` bridged to the boards) |
| `esp32-sdr-trx/` | submodule: [jochenhammes/esp32-sdr-trx](https://github.com/jochenhammes/esp32-sdr-trx), branch `research/iq-tx` (0BSD) |
| `LORA32/` | submodule: [lozaning/LORA32](https://github.com/lozaning/LORA32) (GPL-3.0-or-later) |

## Building

```bash
git submodule update --init
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

**SDR firmware** (only needed to change it; the console carries a built image). ESP-IDF **v5.5.5** exactly (its CI version; v5.5 fails),
and on macOS GNU sed first on `PATH` (the Makefile uses GNU sed syntax; BSD sed silently writes an empty linker script):

```bash
brew install gnu-sed
git clone -b v5.5.5 --depth 1 --recursive --shallow-submodules https://github.com/espressif/esp-idf.git ~/esp/esp-idf-v5.5 && ~/esp/esp-idf-v5.5/install.sh esp32s3
. ~/esp/esp-idf-v5.5/export.sh && export PATH=/opt/homebrew/opt/gnu-sed/libexec/gnubin:$PATH
make -C esp32-sdr-trx/firmware TX=1     # build-tx/iq-source.bin: transmits and receives; the console uses this one
python3 webui/build.py                  # rebuild esp-lora-console.html with it
```

**LORA32** (written to flash; back up the flash first, it is overwritten from 0x0):

```bash
.venv/bin/python -m esptool --chip esp32s3 -p /dev/cu.usbmodemXXXX --before usb-reset --after no-reset read-flash 0 ALL backup.bin
cd LORA32 && ../.venv/bin/python tools/firmware.py flash --port /dev/cu.usbmodemXXXX
```

LORA32's `tools/firmware.py verify` fails on the published repository because its manifest lists a `.gitignore` the upload lacks; `flash`
checks only the three images, which match the published hashes.

## Tests

```bash
npm install                                       # serialport and puppeteer, for the hardware and browser tests
node tests/test_modem.js                          # core.js against esp32-sdr-trx's Python PHY (tools/make_reference.py writes the fixture)
node tests/test_recordings.js DIR                 # decoder on recordings (complex float32, 250 ksps) in DIR
SF=9 PWR=0 GAIN=0 PPM_TX=-39.8 node tests/hw/sdr_link.js                         # two boards, SDR firmware
node tests/hw/lora32_link.js                                                    # two boards, LORA32
PATHS=/dev/cu.usbmodemA,/dev/cu.usbmodemB OUT=. node tests/page/run.js tests/page/sdr_steps.js   # the page itself
```

The hardware tests use the ports of the boards they were written for (`/dev/cu.usbmodem11201`, `/dev/cu.usbmodem11101`); set `RXP`/`TXP`
or `PATHS`. Close the console first: a serial port has one owner.

## Licences

`esp32-sdr-trx` (0BSD) and `LORA32` (GPL-3.0-or-later) keep their own licences; `esp-lora-console.html` contains an esp32-sdr-trx firmware
image built from the submodule. The code in `webui/`, `tools/` and `tests/` has no licence chosen yet.
