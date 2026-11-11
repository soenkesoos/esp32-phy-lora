# Findings: LoRa between ESP32-S3 boards

Measured on 2026-11-11 with two ESP32-S3 dev boards (Embedded PSRAM 8 MB) on their native USB ports, lying next to each other (about 7 cm),
in an RF-shielded room, on macOS. Numbers come from one pair of boards; treat them as indications, not specifications.

| Board | Port (here) | MAC | Flash |
|---|---|---|---|
| A | `/dev/cu.usbmodem11201` | c0:4e:30:0a:b8:f4 | 16 MB |
| B | `/dev/cu.usbmodem11101` | 30:30:f9:6e:a0:3c | 8 MB |

## 1. Summary

* **Plain ESP32-S3 boards can exchange LoRa frames** with either firmware. The esp32-sdr-trx SDR firmware plus this repository's
  JavaScript decoder is far ahead of LORA32: about 60 dB more link margin, SF5 to SF11 instead of SF7 only.
* **The two boards' crystals are 40 ppm apart** (93 kHz at 2.35 GHz). Correcting the transmitter's frequency is not enough: its chirp
  *timing* runs 40 ppm off as well and slips by one chip every third of a second, which breaks SF9 and up. Correcting both (from the first
  received frame, automatically) makes SF9, SF10 and SF11 decode.
* **LORA32 needs 16–26 dB SNR** where LoRa SF7 needs −7.5 dB, and transmits about 17 dB less than the SDR firmware at full power. Its range
  with these boards is under a metre.
* **SF12 does not work** with the polar transmitter: at 62.5 kHz a bin is 15 Hz wide, about the size of the carrier's jitter from symbol
  to symbol.

## 2. Setup and build notes

* **ESP-IDF v5.5.5** exactly (esp32-sdr-trx's CI pin). v5.5 fails (`periph_ll_phy_calibration_module_enable_clk_clear_rst` missing).
* **GNU sed** on macOS: the firmware Makefile generates `build-*/memory.ld` with GNU `sed` syntax (`a\` with `\n`); BSD sed writes an
  empty file, and the link then fails with nothing but orphan-section warnings (made fatal by `--fatal-warnings`).
* **The TX image also receives** (it is built with `NARROWBAND=1 TX=1`): 250 ksps with no loss. One image serves both roles; the console
  embeds it and loads it with esptool's ROM protocol (load-ram, no stub) in about 1 s (esptool itself: about 8 s).
* **Two native ports at once:** esp32-sdr-trx's `--native` loader refuses when two 303a:1001 ports exist; load each with
  `esptool --port P --before usb-reset --after no-reset --no-stub load-ram …` and run the tools with `--no-load --port P`.
* **macOS and CP2102 bridges:** every open of the bridge's port resets the board (an RTS pulse), even with DTR/RTS set to released before
  opening. A firmware link over the UART bridge (attempted for a board without a native USB connection) was abandoned: after the reset the
  RAM firmware is gone, and keeping the port open from esptool's load into the session still gave no working link. Reverted.
* One earlier board had SmartKnob firmware in its flash; RAM loading leaves such firmware untouched.

## 3. SDR firmware (esp32-sdr-trx) and the console's decoder

### How it works

The transmitter is *polar*: it cannot send I/Q, so the host streams one 32-bit record per 25 µs (40 000/s) that sets the carrier's
frequency (1/16 of a 457.76 Hz PLL step) and gain code. A LoRa frame is a frequency track (`frameTrack` in `core.js`, a port of
`lora_phy.frame_track`); bandwidth is limited to 80 kHz by the update rate. The receiver streams 8-bit I/Q at 250 ksps; the console
conjugates it (the radio delivers LO minus RF), removes DC and decodes in a Web Worker.

`core.js`'s encoder is bit-exact with esp32-sdr-trx's Python PHY (symbols and frequency track, `tests/test_modem.js`), and its decoder,
a port of `lora_phy.demodulate`, decodes the Python-decoded recordings as well or better.

### Problems found and how they were solved

| Symptom | Cause | Fix |
|---|---|---|
| The node test hung after configuring the receiver | the receive loop spun on a half packet without yielding to the event loop | wait for more bytes when a pass makes no progress |
| Transmit sessions ended with "no data for 500 ms" while the other board streamed | node-serialport writes on the main loop, starved by per-sample array pushes and inline decoding | typed-array parsing; decoding in a Web Worker |
| Billions of "lost" samples | packet header misread (first-sample counter at bytes 12–15) | offset fixed |
| "Clipping" warning at any gain | magnitude > 120 counted as clipping, but I and Q are separate 8-bit values | count samples with I or Q at the 8-bit limit; show the share |
| Nothing decoded on the user's bench | the decoder only ran when a burst was 4× the background, and took the frequency from the strongest signal (a steady carrier elsewhere) | always decode; scan the window when the quick guesses find nothing (a carrier 23.5 dB above the frames no longer blocks them) |
| Decoded in one direction, never in the other | crystals 40 ppm apart put the signal at ±120 kHz, past the ±94 kHz the decoder searched | search the whole ±125 kHz window with wrap-around; per-board crystal correction |
| SF9 and up: symbols one or two bins off, growing towards the end of a frame | the transmitter's 40 kHz update clock is 40 ppm off too: a timing slip of about one chip per 0.36 s | render the track for the clock's real rate, `rate·(1+ppm)`; the page sets the sender's ppm from the first received frame |
| SF11 frames lost in the page | automatic gain restarted the run in the middle of 1.2 s frames, and the decoder buffer with it | gain decisions on 3 s windows, applied only in a quiet half second; the decoder survives restarts |
| SF11 decoding slower than real time | `median` sorted every spectrum (46 % of the time) | quickselect; three candidate shifts once locked (SF11: 8.6 s CPU for 11.9 s of signal) |

### Results (board B sends, board A receives, receive gain code 0)

| SF, coding rate | without crystal correction | with correction (−39.8 ppm on the sender) |
|---|---|---|
| SF7, 4/5 | 4/4 | 6/6 (recording) |
| SF9, 4/5 and 4/8 | 2–3/4 | 4/4 |
| SF10, 4/8 | 1–3/4 | 4/4 |
| SF11, 4/8 | – | 4/4 (recording), 2/3 live in the page |
| SF12, 4/8 | – | 0/3: removed from the console |

The page's own test (`tests/page/sdr_steps.js`): SF9 3/3 with the correction found from the first frame (−39.5 ppm; the first frame
arrived 93 kHz off, the next ones at +49.8 kHz as aimed); SF11 2/3.

### Things that did not help

* **A second-order tracking loop** (offset plus drift rate) and **a wrap-aware frequency estimator** (phase steps without the step at the
  chirp's wrap): no gain on the failing frames, because their errors were timing slips, not drift. Kept as options (`rateGain`, `unbiased`).
* **Carrying the preamble's drift forward to the SFD** (`sfdDrift`): one SF12 frame more, but worse at SF9–SF11; off by default. A drift
  estimate is used only when it exceeds twice its standard error.
* **Coding rate 4/8 before the timing fix**: it cannot correct a whole frame that has slipped by a bin.

### What limits it

* **Carrier jitter**: the residual frequency of a decided symbol wanders by about ±25 Hz from symbol to symbol (a plain carrier: 1 Hz rms
  in 1 ms, smooth drift of −115 Hz/s). Bins must stay at least ~120 Hz wide (bandwidth / 2^SF) for SF ≤ 11 at 62.5 kHz; SF12 (15 Hz)
  is out. For a fixed bin width all SF/bandwidth pairs give about the same sensitivity.
* **Receiver**: esp32-sdr-trx measured it 16–20 dB less sensitive than a PlutoSDR; next to each other the boards overload it above gain code ~50.

## 4. LORA32

[LORA32](https://github.com/lozaning/LORA32) (INFO19 build) is an autonomous modem: SF7, 1.25 MHz at 2439.5 MHz (LO 2437 MHz + 2.5 MHz),
explicit header, whitening, Hamming, interleaving, CRC; text over a line protocol (`SYNC`, `INFO`, `MODEMCONF`, `MODEMON`, `MODEMSEND`,
`MODEMRX`). Both boards were flashed with the published images after full flash backups; 3/3 broadcasts in each direction and
acknowledged unicast worked, from the command line and from the console.

* **It wedges** when its port is closed while the receiver runs (no answer at all until a reset). The console sends `MODEMOFF` and
  `RELEASE` before it disconnects.
* A probe of the SDR firmware's binary protocol leaves a partial line in LORA32's buffer (`ERR command_length` on the next command); the
  console sends a newline first.

### Gain sweep (board B sends 20 broadcasts per step, board A's `GAINMANUAL` code goes down)

Codes 82 to 20: 20/20; 15: 1/20; 10 and below: 0/20.

### SNR of the LORA32 signal, measured with the SDR firmware on board A (`tools/lora32_snr.py`)

The chirps spread their power evenly over the 1.25 MHz channel, so the power density during frames against between frames, in a
200 kHz slice, is the SNR in the channel. Both firmwares use the same gain register (0x6001C02C, bits 24–30).

| Gain code | 0–17 | 20–25 | 30–35 | 40–50 | 55–60 | 65 | 70 | 80 |
|---|---|---|---|---|---|---|---|---|
| SNR in 1.25 MHz | 9–16 dB | 26 dB | 34–36 dB | **37–39 dB** | 35–36 dB | 31 dB | 27 dB | 18 dB |

Above code ~50 the noise floor rises and the signal saturates: at 7 cm the receiver overloads. LORA32 stops decoding between 26 and
16 dB SNR (codes 20 and 15). Its detector accepts a symbol when the strongest FFT bin holds ≥ 30 % (preamble) or ≥ 25 % (sync, data) of
the power, which should allow about −4 to 0 dB; the gap is probably its 16-bit fixed-point FFT, which halves at each of its 7 stages,
so a weak signal ends up a few counts above zero. The chip's crystal harmonic at **2440.000 MHz lies inside LORA32's channel**
(2438.875–2440.125 MHz). Neither cause is confirmed.

## 5. Transmit power and link budget

Received power at the same receiver (board A, SDR firmware, gain code 30), all transmitted by board B (`tools/rxpower.py`):

| Transmitter | Received power (relative) |
|---|---|
| LORA32, whole 1.25 MHz channel | ~44 dB |
| SDR firmware, carrier at −17.9 dB (its minimum) | ~43–48 dB |
| SDR firmware, carrier at 0 dB (its maximum) | ~61 dB |

With a receiver noise figure of about 5 dB, LORA32's 38 dB SNR at 7 cm means about −70 dBm received, about −50 dBm (10 nW) radiated. The
SDR firmware at full power is ~17 dB stronger.

| | SNR at 7 cm | SNR needed | Margin | Free space | Indoors (exponent 3) |
|---|---|---|---|---|---|
| LORA32 | 38 dB in 1.25 MHz | 16–26 dB | ~17 dB | ~0.5 m | ~0.3 m |
| SDR SF7, 62.5 kHz, 0 dB | ~68 dB (38 + 17 + 13) | ~−6 dB | ~74 dB | ~350 m | ~20 m |
| SDR SF9 | ~68 dB | ~−11 dB | ~79 dB | ~600 m | ~30 m |
| SDR SF11 | ~68 dB | ~−16 dB | ~84 dB | ~1 km | ~45 m |

These are extrapolations from measurements at 7 cm (close to the near field at 12 cm wavelength), from one relative power measurement
(±3 dB) and one pair of boards: assume a factor of 2 either way at best. Data rates: about 2.7 kbit/s at SF7, 0.9 at SF9, 0.27 at SF11
(62.5 kHz, CR 4/5). The real test is moving the boards apart.

## 6. Open ends

* **Range test at distance**, which none of the numbers above replaces.
* **LORA32's receiver**: 20+ dB from a proper LoRa decoder (fixed-point FFT scaling, the 2440 MHz spur). A rebuild needs its pinned
  ESP-IDF commit `25fe69f9…`.
* **SF12 / long frames**: a transmitter with less carrier jitter, or the I/Q playback engine of esp32-sdr-trx's research branch.
* **Crystal correction across sessions**: the console keeps it only while the page is open.
* **Half duplex**: a board switches between sending and receiving in about 0.1 s; acknowledgements and retries in the SDR path are not done.
