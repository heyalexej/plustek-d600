# D600 protocol and timing notes

## Device and transport

Tested identity: original MobileOffice D600, USB `07b3:0c27`, bcdDevice `0500`.
Interface 0 exposes bulk IN `81`, bulk OUT `02`, and interrupt IN `83`.
Register behavior is compatible with the GL843 controller family. The physical
chip identity has not been verified by opening the scanner.

Control transfers use vendor request types `40` (OUT) and `c0` (IN), request
`0c` for a one-byte payload and `04` otherwise. Register reads select the
address with value `83`, await acknowledgement using `8e` / index `20`, then
read with value `84`. Writes send address/value pairs through value `83`.
RAM transfers use value `82` and an eight-byte header with a 32-bit
little-endian length at bytes 4..7. Image FIFO selection is address `45`.

A register read interrupts a pending RAM read on this device. Automatic scanning
therefore completes 64 paired image rows before checking paper status, then
selects the FIFO and issues a fresh RAM read. Each block is 512-byte aligned.
Register 41 bit 3 is clear when paper is present; it is meaningful after
initialization. Three consecutive empty readings debounce the trailing edge.
The driver retains 1024 image rows after the first confirmed edge and rounds
the capture length up to 64 rows. This includes the distance from the input
sensor to both image heads.

GPIO register 6d bit 2 is an active-low Scan button. Interrupt event `04` also
indicates a button press; paper event `20` must not start a scan. The UI requires
a release before rearming a held button and serializes all USB access.

## Image acquisition

Each page is 2480 pixels wide at nominal 600 dpi; the experimental 300 dpi
mode returns 1240 pixels. Grayscale samples are 8-bit;
RGB is 24-bit packed, pixel-interleaved data. The hardware line counter counts
`channels * sides` sensor lines per output row. The same factor determines
buffer stride and the programmed sensor-line limit. The trailing allowance
is 512 rows at 300 dpi, preserving the same physical distance.

Register 16 bit 5 is cleared for the working sensor start-pulse polarity.
The AFE uses SHA sampling, with its register 00 set to `60`. The dummy interval
is `43 + 2 * (register 1d & 31)`: 47 for simplex and 57 for duplex.
Empty shading tables and gamma are bypassed. This restores usable brightness
and full sensor width, but does not supply a white reference calibration.

Duplex register differences include 01=`b2`, 05=`48`, 0c=`09`, 1d=`07`,
59=`32`. DPISET is 1200 for combined duplex readout; each head still delivers
600 dpi optical samples. SEL3INV (9e bit 6) is clear in duplex mode.

A duplex row comprises two blocks A and B, each `2480 * channels` bytes:

- Grayscale front: B; back: A mirrored horizontally.
- RGB front pixel: `(B.R, A.G, B.B)`.
- RGB back pixel: `(A.R, B.G, A.B)`, then mirror by whole pixels.

Front is the face inserted down. Both head margins are retained independently;
the heads have a vertical offset and there is no automatic registration or
rotation. `src/d600-image.h` implements only separation and mirroring, without
resampling. Both output files must validate before the UI publishes a duplex
scan. The `.raw` sidecar retains the original combined stream.

## Timing and transport

Under the tested 30 MHz configuration, a line-period unit is approximately
`12 / 30 MHz = 400 ns`. One logical output row takes:

```
row_seconds = line_period * channels * sides * 400 ns
motor_interval = line_period * channels * sides * dpi / 1200
```

The latter preserves approximately two quarter-steps per 600 dpi image row.
A motor table interval is a 16-bit value. The driver rejects values that exceed
65535. The scan clock and motor must change together, otherwise vertical
geometry changes. This relationship was checked by matching document outlines
at periods 20000 and 12000, but is not a metrological calibration.

At period 20000, gain zero and RGB exposures 10000, a short full color duplex
scan captured 3904 rows per face in 188.202 s from scan-enable to stop. At period
12000 with the same exposure/gain, the same row count took 112.942 s including
the register setup immediately before scan-enable. Both front and back showed
complete paper outlines and comparable brightness. Tail ejection completed.
Different insertion positions may change the retained leading blank margin.

The 600 dpi device configuration specifies period 2800 and separate RGB
exposures 2304, 2175, 2048. For the same 3904 rows, 2800 would imply 26.24 s of
sensor time. This is a timing calculation, **not a validated scan result**.
Shorter exposures need matched analog gain, dark offsets and white calibration.
The UI retains conservative timing until additional modes are validated.

The 300 dpi configurations use period 1400 with different sensor timing and
exposure settings. The native driver now selects those profiles and halves the
sensor window while retaining combined-readout DPISET at 600 * sides. This
avoids applying a second digital decimation after the sensor mode already
halves the sample count. Stationary RGB duplex at period 1400 returned 476160
bytes for 64 paired rows (1240 pixels per page), with exactly 384 completed
sensor lines, in 0.252 s including acquisition setup. The motor stayed disabled.
No document was present in that stationary test: it verifies FIFO framing and
counter behavior, not document geometry, brightness or full-width coverage. Manufacturer speeds for 300 dpi are linked in the
README and cannot be used as a direct 600 dpi benchmark.

The device's transport curve is described by start percentage 50, maximum
full-step rate 5680 and exponent parameter 210. With 256 entries and quarter
steps, its speed model is:

```
v[i] = floor((5680 * 4) * (i / 255) ** (100 / 210)), i = 1..255
v[0] = max(1, floor(v[1] * 0.5))
interval[i] = floor(2500000 / v[i])
```

Intervals are clamped to the target scan interval after reaching that speed.
The initial intervals are 3082, 1540, 1107, 912, 795, 715. For RGB duplex at
period 2800 the target is 8400, so even the first curve entry is faster than
the requested scan speed and the clamped table is constant. Faster grayscale
transport may require the initial acceleration entries. The native driver now builds this curve in `src/d600-timing.h`; tests check
known initial interval vectors, monotonic acceleration and target clamping.
Slow modes retain the proven 32-entry constant-speed setup. Faster modes use
the number of entries needed to reach the target, for both acceleration and
deceleration. The 300 dpi RGB duplex target is 2100 (two ramp entries), and the
grayscale duplex target is 700 (seven entries). RGB duplex at 300 dpi has now
completed a full document test; other 300 dpi combinations remain unvalidated.

Motor tables are uploaded to volatile RAM at `40000 + table * 8000` via
registers 5b/5c. No firmware or EEPROM writes are performed. Stop clears scan,
motor and illumination enables and checks that the motor-enable status is zero.
SIGINT/SIGTERM take this cleanup path. Do not force-kill the process.

Bounded tail ejection requires a clear input sensor and runs 1536 microsteps
plus deceleration with a ten-second deadline. It is separate from image
acquisition. `D600_FEED_PERIOD=1000` experimentally speeds up this operation
with a four-entry ramp. An empty-feeder test completed 1540 counted steps,
reported hardware completion and motor enable zero, and took 0.764 s from
motor start through cleanup. A subsequent complete 300 dpi RGB duplex scan
also completed paper ejection at this speed, with 1540 counted steps, hardware
completion and motor enable zero. The fast UI preset uses period 1000; the
standard preset and standalone feed default remain 10000.
Automatic scans are limited to 32768 logical rows per page;
incomplete transfers and missing paper ends do not produce a completed scan.

### Complete 300 dpi RGB duplex test

A stationary paper test exposed a clock-waveform problem in the initial 300 dpi
RGB duplex profile: most of the page was dark despite correct FIFO byte counts.
Increasing analog gain clipped a narrow strip without restoring full-width
coverage. The working profile uses CK1 waveform registers 75/76 = 007e and
register 16 = 14, together with the existing 300 dpi clock selection. Other
300 dpi profiles have not been changed without a corresponding image test.

At line period 1400, retain RGB exposures 1184/1183/1088 and use AFE gain 49.
The full moving test returned 2048 paired rows (1240 pixels per face),
15,237,120 raw bytes, in 6.908 s acquisition. The scan process took 7.647 s;
setup, scan and fast tail ejection took 8.779 s combined. Both paper outlines
were complete, both sides readable and colors visible. Pixel geometry has
not been calibrated against a ruler at 300 dpi. Fine shading stripes and a
color cast remain; gain is an empirical preset for this device, not automatic
white calibration. This profile is exposed as the fast UI preset and also
applies to physical-button scans. The standard preset retains 600 dpi timing.
A subsequent real physical-button scan through the UI captured 2112 paired
rows in 7.122 s, published both complete images and completed fast ejection.

## Validation and remaining work

On one original D600 connected to Intel macOS:

- Full grayscale duplex receipt: two 2480 × 3968 pages, both edges visible.
- Full color duplex receipt: two 2480 × 3904 pages, both edges visible.
- Both modes started with the physical button, completed tail ejection and
  exposed both image previews and downloads through the local UI.
- A faster RGB duplex scan at period 12000 preserved the full document.
- A 300 dpi RGB duplex scan at period 1400 preserved both complete sides in 6.908 s.
- Native pixel tests and isolated UI tests cover separation, mirroring,
  file validation, button handling and cancellation.

Unvalidated: Linux USB runtime, other hardware revisions, precision duplex/RGB
geometry, other fast scan modes, comprehensive jam detection, shading and color
calibration. Full-width duplex RGB at the current row limit buffers about
488 MB of raw data; a memory-constrained legacy Linux target will need a lower
limit or a streaming implementation. `D600_LINES` can lower the cap; reaching
it before the paper end is deliberately reported as an incomplete scan.
