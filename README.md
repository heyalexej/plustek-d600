# Plustek D600 scanner for macOS and Linux

An experimental native USB driver and local web interface for the **original
Plustek MobileOffice D600**, USB `07b3:0c27`, revision `0500`.

Scan receipts and small documents without a Windows host. The driver is C99
with libusb; the optional web interface is plain JavaScript and Node.js with no
npm dependencies. It defaults to **English**, with **German** available in the
language menu. Explicit language selections are remembered.

## What works

- 600 dpi grayscale and 24-bit RGB, single-sided and double-sided.
- Fast 300 dpi RGB duplex preset, tested with a complete receipt.
- Both sides in one pass, with separate previews and PNG / PGM / PPM downloads.
- Variable document length, paper-end detection and bounded tail ejection.
- Start from the interface or the physical Scan button; stop with motor cleanup.
- Local history and persistent color/side settings. Scan files stay on this machine.

Hardware tests have been performed on Intel macOS with one original D600.
**Linux hardware operation is not yet tested.** This is not a SANE backend and
does not support the D600 Plus or other USB IDs. 600 dpi is the nominal sensor
resolution; RGB and duplex geometry have not received a full calibration.
Fine vertical shading stripes remain. There is no automatic crop, rotation,
deskew, white balance or ICC color management yet.

## Build and start

Requirements: a C99 compiler, Make, pkg-config and libusb 1.0. Node.js 20 or newer
is needed for the optional UI, profile builder and JavaScript tests.

macOS with Homebrew:

```sh
brew install libusb pkg-config node
make all profiles
make ui
```

Debian/Ubuntu:

```sh
sudo apt install build-essential pkg-config libusb-1.0-0-dev
# Install Node.js 20+ if you want the browser interface.
make all
```

Prebuilt profile data is included, so a legacy Linux host only needs the C tool
and libusb to scan. A modern browser UI host is optional. On older Linux systems
where clock_gettime requires librt, use `make LDFLAGS=-lrt`.

Open **http://127.0.0.1:8765**. Choose a scan preset, insert the document straight,
face down, close the lid and press **Start scan** or the button on the scanner.
For double-sided scans, Front is the face inserted down; Back is the other face.
Use the page buttons to choose the side to download. Language changes do not
change the scan settings. The fast preset uses 300 dpi color on both sides.
The standard preset provides the existing 600 dpi color and side choices.
The physical button uses the same selected preset.

The UI binds to loopback only. Run one scanner process at a time. Stop the UI
before using the command-line driver or benchmark tool.

On Linux, USB access may need a local udev rule or an existing scanner group.
Use `sh tools/probe-linux.sh` to collect device and system details. Do not change
permissions for unrelated USB devices.

## Command line

```sh
make all
artifacts/bin/d600-probe
artifacts/bin/d600-experiment --status

# Conservative, full-length double-sided color scan:
D600_LINE_PERIOD=20000 D600_EXPOSURE=10000 D600_GAIN=0 \
  artifacts/bin/d600-experiment --scan-auto \
  profiles/native-duplex-color600.json receipt.ppm

# Once the paper-end sensor is clear, release the remaining trailing edge:
artifacts/bin/d600-experiment --eject-tail profiles/native-gray600.json
```

For grayscale use `native-gray600.json` or `native-duplex-gray600.json` and a
`.pgm` output name. For single-sided color use `native-color600.json`.
A double-sided scan writes `receipt.ppm` and `receipt-back.ppm`. The `.raw`
sidecar preserves the combined USB stream; it is not a ready-to-display image.
The UI stores scans, metadata and logs under `captures/ui/` (ignored by Git).

The driver refuses ambiguous or unsupported devices and requires paper before
moving scans. SIGINT/SIGTERM stop acquisition, motor and illumination. Scan
limits and timeouts bound operation; incomplete scans are not published as
successful images. These checks are not comprehensive mechanical jam detection.

## Speed experiments

The fast UI preset completed a full receipt in **6.908 s acquisition** at
300 dpi RGB duplex, producing two **1240 × 2048** images. Both complete paper
outlines and readable text were checked. Scan process time was **7.647 s**;
setup, acquisition and fast ejection together took **8.779 s** in the CLI
benchmark. UI PNG conversion adds some processing time. This was one document
on one scanner, not a standardized benchmark or full color calibration.
A second scan started with the physical button through the UI completed
2112 rows per face in **7.122 s**, including complete images and fast ejection.

The earlier conservative 600 dpi scan of this receipt took **188.2 s**;
a period-12000 experiment took **112.9 s**. The new result is about **27× faster
than the original scan**, but also uses half the resolution on each axis.
This is a workflow comparison, not an equal-resolution speed comparison.

The manufacturer's published speeds are for **300 dpi**:
3.1 s single-sided / 6.5 s double-sided color; 1.1 s / 1.7 s grayscale in the
[D600 manual](https://downloads.plustek.com/downloads/english/user_guide/D600-userguide-english.pdf).
A [later catalog](https://downloads.plustek.com/downloads/english/leaflet/ALLAE-03010.pdf)
explicitly specifies A6 and gives 1.3 s for single-sided grayscale. Our 6.908 s
color-duplex capture is close to that rating, but the test receipt and timing
boundaries are not identical to the manufacturer's benchmark.

Reproduce the tested preset after stopping the UI and inserting paper:

```sh
node tools/benchmark.mjs --dpi 300 --period 1400 --gain 49 \
  --mode color --duplex --feed-period 1000 \
  --output captures/benchmark/fast-color
```

The fast profile retains separate RGB exposure values and uses a corrected
sensor clock waveform. Gain 49 was checked on this test piece; white balance
and shading are still uncalibrated. Other 300 dpi combinations remain CLI-only
experiments and have not passed complete document image validation. The UI
only offers the tested RGB duplex combination. See [timing notes](docs/protocol.md).

## Tests

```sh
make test-native test-ui
```

The native tests check duplex block separation, crossed RGB green channels and
rear-side mirroring. Isolated UI tests use a fake driver and never access USB;
they cover downloads, RGB, duplex completion, cancellation, paper-end limits,
button handling, settings persistence and translation coverage.

## Project layout

- `src/`: native driver and USB probe.
- `profiles/`: 600 dpi configurations and experimental 300 dpi configurations and binary companions.
- `ui/`: local English/German web interface and lossless PNG conversion.
- `tools/`: profile builder, benchmark runner and Linux identification helper.
- `docs/protocol.md`: USB framing, image layout, timing and current limitations.

MIT licensed. Independent project; not affiliated with Plustek.
