/* Native D600 protocol experiments. Requires original 07b3:0c27, revision 0500.
 * See docs/protocol.md for hardware behavior and scan timing.
 * No firmware/EEPROM writes. Motion only in feed/scan modes.
 */
#define _POSIX_C_SOURCE 200809L
#include <libusb.h>
#include <errno.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "d600-image.h"
#include "d600-timing.h"

static libusb_device_handle *usb;
static volatile sig_atomic_t interrupted;
static unsigned char regs[192], present[192];
static int dirty;
static int quiet_usb;

static void on_signal(int signal_number) { interrupted = signal_number; }
static void delay_ms(unsigned ms)
{
    struct timespec t = {(time_t)(ms / 1000), (long)(ms % 1000) * 1000000};
    while (nanosleep(&t, &t) && errno == EINTR && !interrupted) {}
}
static double now(void)
{
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec + t.tv_nsec / 1e9;
}
static int control(int input, uint16_t value, uint16_t index,
                   unsigned char *bytes, uint16_t length)
{
    int result = libusb_control_transfer(usb, input ? 0xc0 : 0x40,
        length == 1 ? 0x0c : 0x04, value, index, bytes, length, 1000);
    unsigned i;
    if (!quiet_usb || result != length) {
    fprintf(stderr, "%.3f USB %s value=%04x index=%04x len=%u result=%d data=",
            now(), input ? "IN" : "OUT", value, index, length, result);
    for (i = 0; i < length && (!input || (int)i < result); ++i)
        fprintf(stderr, "%02x", bytes[i]);
    fputc('\n', stderr);
    }
    if (result != length) {
        fprintf(stderr, "Control transfer failed: %s\n",
                result < 0 ? libusb_error_name(result) : "short transfer");
        return -1;
    }
    return 0;
}
static int write_control(uint16_t value, uint16_t index, unsigned char *bytes,
                         uint16_t length)
{
    unsigned char ack = 0;
    /* No blind write retries: a timed-out command may already have executed. */
    if (control(0, value, index, bytes, length)) return -1;
    if (control(1, 0x8e, 0x20, &ack, 1)) return -1;
    if (!(ack & 1)) { fputs("Missing command acknowledgement\n", stderr); return -1; }
    return 0;
}
static int read_reg(unsigned char address, unsigned char *value)
{
    if (write_control(0x83, 0, &address, 1)) return -1;
    return control(1, 0x84, 0, value, 1);
}
static int write_reg(unsigned char address, unsigned char value)
{
    unsigned char pair[2] = {address, value};
    dirty = 1;
    if (write_control(0x83, 0, pair, 2)) return -1;
    if (address < sizeof(regs)) { regs[address] = value; present[address] = 1; }
    return 0;
}
static int write_be(unsigned char address, unsigned value, unsigned count)
{
    unsigned i;
    for (i = 0; i < count; ++i)
        if (write_reg(address + i, (value >> (8 * (count - i - 1))) & 255)) return -1;
    return 0;
}
static int status(void)
{
    const unsigned char addresses[] = {1, 2, 3, 4, 5, 6, 0x0b, 0x40, 0x41, 0x6c, 0x6d};
    size_t i;
    unsigned char gpio = 0, events = 0;
    for (i = 0; i < sizeof(addresses); ++i) {
        unsigned char value;
        if (read_reg(addresses[i], &value)) return -1;
        printf(" %02x=%02x", addresses[i], value);
        if (addresses[i] == 0x6d) gpio = value;
    }
    /* D600 BUTTONS=1,04 / BUTTONID=4. Hardware verified: GPIO 6d bit 2
     * is active low, endpoint 83 reports 04 on press (20 is paper change).
     * Drain pending events so a quick press between status polls is retained. */
    for (i = 0; i < 16; ++i) {
        unsigned char event = 0; int got = 0;
        int rc = libusb_interrupt_transfer(usb, 0x83, &event, 1, &got, 1);
        if (rc == LIBUSB_ERROR_TIMEOUT) break;
        if (rc) return -1;
        if (got) events |= event;
    }
    printf(" button=%u irq=%02x", !(gpio & 4), events);
    putchar('\n');
    return 0;
}
static int dump_registers(void)
{
    unsigned address;
    for (address = 0; address < sizeof(regs); ++address) {
        unsigned char value;
        if (read_reg((unsigned char)address, &value)) return -1;
        printf("%02x=%02x%c", address, value, address % 16 == 15 ? '\n' : ' ');
    }
    return 0;
}
static int watch_buttons(void)
{
    double deadline = now() + 120, next_status = 0;
    int previous_gpio = -1;
    quiet_usb = 1;
    puts("Watching button GPIO and interrupt endpoint for 120 seconds; motor unchanged.");
    while (!interrupted && now() < deadline) {
        unsigned char event = 0, gpio, sensor;
        int got = 0;
        int rc = libusb_interrupt_transfer(usb, 0x83, &event, 1, &got, 100);
        if (rc && rc != LIBUSB_ERROR_TIMEOUT) return -1;
        if (got) printf("Button interrupt=%02x\n", event);
        if (read_reg(0x6d, &gpio) || read_reg(0x41, &sensor)) return -1;
        if (gpio != previous_gpio || now() >= next_status) {
            printf("Button watch: gpio6d=%02x status41=%02x\n", gpio, sensor);
            previous_gpio = gpio; next_status = now() + 2;
        }
    }
    return 0;
}
static int stop(void)
{
    int failed = 0;
    unsigned char value;
    puts("Stopping acquisition, disabling motor and lamp...");
    /* Try each independently even after an error. Cached value is fallback only. */
    value = regs[1];
    if (read_reg(1, &value)) failed = 1;
    if (write_reg(1, value & ~1)) failed = 1;
    value = regs[2];
    if (read_reg(2, &value)) failed = 1;
    if (write_reg(2, value & ~0x10)) failed = 1;
    value = regs[3];
    if (read_reg(3, &value)) failed = 1;
    if (write_reg(3, value & ~0x10)) failed = 1;
    /* D600 CisLampCtl: front illumination GPIO 6c bit 7. */
    value = regs[0x6c];
    if (read_reg(0x6c, &value)) failed = 1;
    if (write_reg(0x6c, value & ~0x80)) failed = 1;
    value = regs[0xa6];
    if (read_reg(0xa6, &value)) failed = 1;
    if (write_reg(0xa6, value & ~2)) failed = 1;
    { double deadline = now() + 1;
      do {
        delay_ms(50);
        if (read_reg(0x41, &value)) { failed = 1; break; }
        if (!(value & 1)) break;
      } while (now() < deadline);
      printf("Stopped status41=%02x motor_enable=%u\n", value, value & 1);
      if (value & 1) failed = 1;
    }
    return failed ? -1 : 0;
}
static int load_file(const char *prefix, const char *suffix, unsigned char *bytes,
                     size_t capacity, size_t *length)
{
    char path[4096];
    FILE *file;
    int n = snprintf(path, sizeof(path), "%s%s", prefix, suffix);
    if (n < 0 || (size_t)n >= sizeof(path)) return -1;
    file = fopen(path, "rb");
    if (!file) { perror(path); return -1; }
    *length = fread(bytes, 1, capacity, file);
    if (ferror(file) || !feof(file)) { fclose(file); return -1; }
    fclose(file);
    return 0;
}
static int initialize(const char *prefix)
{
    unsigned char pairs[512], afe[192], clock = 0xa4;
    size_t count, afe_count, i;
    if (load_file(prefix, ".registers.bin", pairs, sizeof(pairs), &count) ||
        load_file(prefix, ".afe.bin", afe, sizeof(afe), &afe_count)) return -1;
    if (count != 200 || afe_count != 24) { fputs("Unexpected profile sizes\n", stderr); return -1; }
    for (i = 0; i < count; i += 2) {
        if (pairs[i] >= sizeof(regs) || present[pairs[i]]) return -1;
        regs[pairs[i]] = pairs[i+1]; present[pairs[i]] = 1;
    }
    if ((regs[1] != 0xa2 && regs[1] != 0xb2) || (regs[4] != 0x2a && regs[4] != 0x22) ||
        !((regs[0x38] == 0x0a && regs[0x39] == 0xf0) || (regs[0x38] == 0x05 && regs[0x39] == 0x78))) {
        fputs("Experiment requires SINGLE/DUPLEX Gray or Color 300/600 profile\n", stderr); return -1;
    }
    { const char *text = getenv("D600_GAIN");
      if (text) {
        char *end; unsigned long gain = strtoul(text, &end, 10);
        if (!*text || *end || gain > 63) {
            fputs("D600_GAIN must be 0..63\n", stderr); return -1;
        }
        printf("Experimental AFE gain code=%lu\n", gain);
        for (i = 0; i < afe_count; i += 3)
            if (afe[i] >= 2 && afe[i] <= 4) { afe[i+1] = 0; afe[i+2] = (unsigned char)gain; }
      }
    }
    /* Do not enable motor, lamp, gamma, shading, or scan while loading defaults. */
    regs[1] &= ~0x29; regs[2] = 0; regs[3] &= ~0x10; regs[5] &= ~8;
    puts("Loading sensor defaults with motor disabled...");
    for (i = 0; i < count; i += 2) {
        unsigned char address = pairs[i];
        if (interrupted || write_reg(address, regs[address])) return -1;
    }
    /* Set the sensor clock and initialize volatile DRAM. */
    if (write_control(0x8c, 0x10, &clock, 1) ||
        write_reg(0x0b, (regs[0x0b] & 0x1f) | 0x20) ||
        write_reg(0x0b, regs[0x0b] & ~8) ||
        write_reg(0xa2, (regs[0xa2] & 0xe0) | 0x0f) ||
        write_reg(0x0b, regs[0x0b] | 8)) return -1;
    delay_ms(100);
    /* AFE serial writes: address, high byte, low byte. */
    for (i = 0; i < afe_count; i += 3) {
        unsigned char data[6] = {0x51, afe[i], 0x3a, afe[i+1], 0x3b, afe[i+2]};
        if (write_control(0x83, 0, data, sizeof(data))) return -1;
    }
    /* AFE serial readback returned zero even when gain/offset writes changed
     * images. Do not present those zeroes as verified configuration values. */
    return status();
}
static int motor_tables(unsigned period, int accelerate)
{
    unsigned char data[512], header[8] = {1, 0, 0, 0, 0, 2, 0, 0};
    unsigned short curve[256];
    unsigned table, i;
    if (accelerate) d600_motor_curve(curve, period);
    puts("Uploading bounded motor tables to volatile RAM...");
    for (i = 0; i < sizeof(data); i += 2) {
        unsigned interval = accelerate ? curve[i / 2] : period;
        data[i] = interval & 255; data[i+1] = interval >> 8;
    }
    /* Volatile motor RAM: 0x40000 + table * 0x8000. */
    for (table = 0; table < 5; ++table) {
        unsigned char address = 0x28, flags = 0;
        int transferred = 0, rc;
        double deadline;
        if (interrupted || write_be(0x5b, 0x4000 + table * 0x800, 2) ||
            write_control(0x83, 0, &address, 1) ||
            write_control(0x82, 0, header, sizeof(header))) return -1;
        rc = libusb_bulk_transfer(usb, 0x02, data, sizeof(data), &transferred, 1000);
        fprintf(stderr, "Motor table %u: USB=%d bytes=%d\n", table, rc, transferred);
        if (rc || transferred != sizeof(data)) return -1;
        deadline = now() + 1;
        do {
            if (control(1, 0x8e, 0x18, &flags, 1)) return -1;
            if (!(flags & 0x0c)) break;
            delay_ms(5);
        } while (now() < deadline && !interrupted);
        if (flags & 0x0c) return -1;
    }
    return write_be(0x5b, 0, 2);
}
static int feed(int reverse, int tail)
{
    const unsigned target = tail ? 1536 : 256;
    const unsigned timeout = tail ? 10 : 3;
    unsigned period = 10000, ramp = 32;
    unsigned char sensor, high, middle, low, flags;
    unsigned steps = 0;
    double deadline;
    int finished = 0;
    { const char *text = getenv("D600_FEED_PERIOD");
      if (text) {
        char *end;
        unsigned long value = strtoul(text, &end, 10);
        unsigned short curve[256];
        if (!*text || *end || value < 700 || value > 10000) {
            fputs("D600_FEED_PERIOD must be 700..10000\n", stderr); return -1;
        }
        period = (unsigned)value;
        ramp = d600_motor_curve(curve, period);
        if (ramp == 1) ramp = 32;
      }
    }
    if (read_reg(0x41, &sensor)) return -1;
    if (tail && !(sensor & 8)) {
        fputs("Tail ejection requires the paper's trailing edge to have cleared the sensor\n", stderr); return -1;
    }
    if (!tail && (sensor & 8)) {
        fputs("No paper at feed sensor; feed refused\n", stderr); return -1;
    }
    if (motor_tables(period, 1)) return -1;
    /* Quarter-step mode, bounded travel and matched acceleration/deceleration. */
    if (write_reg(1, regs[1] & ~1) || write_reg(2, reverse ? 0x54 : 0x50) ||
        write_reg(0x21, ramp) || write_reg(0x22, 0) || write_reg(0x23, 0) ||
        write_reg(0x24, ramp) || write_reg(0x69, ramp) || write_reg(0x6a, ramp) ||
        write_reg(0x5f, ramp) || write_be(0x25, 0, 3) ||
        write_be(0x60, 0, 3) || write_be(0x63, 0, 3) ||
        write_be(0x3d, target - ramp, 3) || write_reg(0x0d, 5)) return -1;
    printf("Feed timing: period=%u ramp=%u\n", period, ramp);
    printf("Feeding %s: %u programmed microsteps plus deceleration (%u-second deadline)...\n",
           reverse ? "backward" : "forward", target, timeout);
    if (write_reg(0x0f, 1)) return -1;
    deadline = now() + timeout;
    do {
        delay_ms(20);
        if (interrupted || read_reg(0x41, &flags) || read_reg(0x48, &high) ||
            read_reg(0x49, &middle) || read_reg(0x4a, &low)) return -1;
        steps = ((high & 0x1f) << 16) | (middle << 8) | low;
        /* The 21-bit position counter decrements and wraps in reverse. */
        if (reverse) steps = (0x200000U - steps) & 0x1fffffU;
        printf("Feed counter=%u status41=%02x\n", steps, flags);
        if (flags & 0x20) { finished = 1; break; }
        /* At exactly target, FEEDFSH may not yet be latched. Allow the
         * programmed 32-step deceleration plus one polling interval. */
        if (steps > target + 64) break;
    } while (now() < deadline);
    if (stop()) return -1;
    printf("Feed ended: %u counted steps, hardware completion=%d\n", steps, finished);
    return finished && steps > 0 ? 0 : -1;
}
static int acquire(const char *path, int moving, int automatic)
{
    const unsigned dpi = regs[0x38] == 0x05 ? 300 : 600;
    const unsigned width = dpi == 300 ? 1240 : 2480;
    const unsigned tail_rows = dpi == 300 ? 512 : 1024;
    const unsigned channels = (regs[4] & 0x0c) ? 1 : 3;
    const unsigned sides = (regs[1] & 0x10) ? 2 : 1;
    const unsigned sensor_lines = channels * sides;
    const unsigned stride = width * sensor_lines;
    unsigned lines = automatic ? 32768 : moving ? 512 : 64, total, goal_bytes;
    unsigned next_paper_check = 0, empty_count = 0, edge_line = 0, end_line = 0;
    unsigned char *data = NULL, byte, header[8];
    unsigned received = 0, bulk_remaining = 0;
    double deadline, capture_started = 0;
    FILE *file = NULL;
    int result = -1;
    unsigned period = moving || channels == 3 ? 20000 : (dpi == 300 ? 1400 : 2800);
    unsigned exposure = 0, x_start = dpi == 300 ? 40 : 80;
    unsigned filter = channels == 3 ? 0 : 2, side = 1, lamps = 3;
    const char *lines_text = getenv("D600_LINES");
    if (lines_text) {
        char *end;
        unsigned long parsed = strtoul(lines_text, &end, 10);
        if (!*lines_text || *end || parsed < 64 || parsed > (automatic ? 32768UL : moving ? 4096UL : 256UL)) {
            fputs("D600_LINES must be 64..32768 for auto, 64..4096 for scan, 64..256 for stationary\n", stderr); return -1;
        }
        lines = (unsigned)parsed;
    }
    const char *period_text = getenv("D600_LINE_PERIOD");
    const char *filter_text = getenv("D600_FILTER"), *side_text = getenv("D600_SIDE");
    const char *lamps_text = getenv("D600_LAMPS");
    if (lamps_text) {
        if (strlen(lamps_text) != 1 || lamps_text[0] < '0' || lamps_text[0] > '3') { free(data); return -1; }
        lamps = lamps_text[0] - '0';
    }
    if (filter_text && channels == 1) {
        if (strlen(filter_text) != 1 || filter_text[0] < '1' || filter_text[0] > '3') { free(data); return -1; }
        filter = filter_text[0] - '0';
    }
    if (side_text) {
        if (strcmp(side_text, "0") && strcmp(side_text, "1")) { free(data); return -1; }
        side = side_text[0] - '0';
    }
    if (period_text) {
        char *end;
        unsigned long parsed = strtoul(period_text, &end, 10);
        if (!*period_text || *end || parsed < (dpi == 300 ? 1400UL : 2800UL) || parsed > 60000) {
            fputs("D600_LINE_PERIOD must be at least the profile period and at most 60000\n", stderr); free(data); return -1;
        }
        period = (unsigned)parsed;
    }
    { const char *text = getenv("D600_EXPOSURE");
      if (text) {
        char *end; unsigned long parsed = strtoul(text, &end, 10);
        if (!*text || *end || parsed < 1 || parsed >= period) {
            fputs("D600_EXPOSURE must be positive and below line period\n", stderr); free(data); return -1;
        }
        exposure = (unsigned)parsed;
      }
    }
    { const char *text = getenv("D600_X_START");
      if (text) {
        char *end; unsigned long parsed = strtoul(text, &end, 10);
        if (!*text || *end || parsed < 1 || parsed > 4096) {
            fputs("D600_X_START must be 1..4096\n", stderr); return -1;
        }
        x_start = (unsigned)parsed;
      }
      if (x_start + width >= period) {
        fputs("Image window must end before the line period\n", stderr); return -1;
      }
    }
    /* Measured mono line time: 12 / 30 MHz per period unit. CIS RGB requires
     * three sensor lines per output row: bounds are 40/270 seconds per channel. */
    if ((double)lines * period * 12 / 30000000 > (automatic ? 270 : 40)) {
        fputs("Requested acquisition exceeds the bounded line time\n", stderr); return -1;
    }
    total = stride * lines;
    goal_bytes = total;
    data = calloc(total, 1);
    if (!data) return -1;
    if (moving) {
        if (read_reg(0x41, &byte) || (byte & 8)) {
            fputs("No paper at feed sensor; scan refused\n", stderr); goto done;
        }
        /* Keep transport distance per image row constant when changing speed. */
        unsigned motor_period = (period * sensor_lines * dpi) / 1200;
        unsigned short curve[256];
        unsigned ramp = d600_motor_curve(curve, motor_period);
        if (ramp == 1) ramp = 32; /* Preserve the proven slow-mode transport setup. */
        if (motor_period > 65535) {
            fputs("Line period exceeds the motor table range\n", stderr); goto done;
        }
        printf("Scan timing: line_period=%u motor_period=%u channels=%u sides=%u\n",
               period, motor_period, channels, sides);
        printf("Resolution=%u dpi; ramp=%u steps\n", dpi, ramp);
        if (motor_tables(motor_period, 1) || write_reg(0x21, ramp) || write_reg(0x22, 0) ||
            write_reg(0x23, 0) || write_reg(0x24, ramp) || write_reg(0x69, ramp) ||
            write_reg(0x6a, ramp) || write_reg(0x5f, ramp) ||
            write_be(0x60, 0, 3) || write_be(0x63, 0, 3)) goto done;
    }
    printf("Capturing up to %u lines; motor %s...\n", lines, moving ? "enabled" : "disabled");
    if (automatic) printf("Automatic document scan: waiting for trailing edge, then %u image rows of transport allowance.\n", tail_rows);
    printf("Experimental line period=%u filter=%u side=%u lamps=%u\n", period, filter, side, lamps);
    printf("Horizontal sensor window=%u..%u\n", x_start, x_start + width);
    if (exposure) {
        printf("Experimental RGB exposure=%u\n", exposure);
        if (write_be(0x10, exposure, 2) || write_be(0x12, exposure, 2) || write_be(0x14, exposure, 2)) goto done;
    }
    capture_started = now();
    /* GL843 DVDSET (bit 5) enables shading multiplication; bypass empty tables. */
    if (write_reg(1, regs[1] & ~0x2b) || write_reg(2, moving ? 0x50 : 0) ||
        write_reg(3, (regs[3] & ~0x20) | 0x10) ||
        write_reg(0x6c, (regs[0x6c] & ~0x80) | ((lamps & 1) ? 0x80 : 0)) ||
        write_reg(0xa6, (regs[0xa6] & ~2) | (lamps & 2)) ||
        write_reg(4, (regs[4] & ~0x0c) | (filter << 2)) ||
        /* Select the simplex head; duplex uses both heads. */
        write_reg(0x9e, (regs[0x9e] & ~0x40) | (sides == 2 ? 0 : side << 6)) ||
        write_be(0x2c, 600 * sides, 2) || write_be(0x30, x_start, 2) ||
        write_be(0x32, x_start + width, 2) || write_be(0x35, stride / 2, 3) ||
        write_be(0x25, lines * sensor_lines, 3) || write_be(0x3d, moving ? 1 : 0, 3) || write_be(0x38, period, 2) ||
        write_reg(0x0d, 5) || write_reg(1, regs[1] | 1) || write_reg(0x0f, moving ? 1 : 0)) goto done;
    deadline = now() + 5;
    do {
        if (interrupted || read_reg(0x41, &byte)) goto done;
        if (!(byte & 0x40)) break;
        delay_ms(20);
    } while (now() < deadline);
    printf("Capture status41=%02x\n", byte);
    if (byte & 0x40) { fputs("Image FIFO stayed empty\n", stderr); goto done; }
    byte = 2;
    if (write_control(0x8c, 0x0f, &byte, 1)) goto done;
    byte = 0x45;
    if (write_control(0x83, 0, &byte, 1)) goto done;
    /* Bulk IN RAM read, 32-bit little-endian transfer length. */
    header[0]=0; header[1]=0; header[2]=0x82; header[3]=0;
    header[4]=total&255; header[5]=(total>>8)&255;
    header[6]=(total>>16)&255; header[7]=(total>>24)&255;
    if (!automatic && write_control(0x82, 0, header, sizeof(header))) goto done;
    deadline = now() + 5 + (double)lines * sensor_lines * period * 12 / 30000000;
    while (received < goal_bytes && !interrupted && now() < deadline) {
        unsigned available = goal_bytes - received;
        if (automatic) {
            if (!bulk_remaining) {
                /* Register reads interrupt an in-flight RAM read command on
                 * this controller. Complete a 64-row USB block before polling
                 * paper, then select image FIFO and issue the next RAM read. */
                bulk_remaining = available < stride * 64 ? available : stride * 64;
                byte = 0x45;
                if (write_control(0x83, 0, &byte, 1)) goto done;
                header[4]=bulk_remaining&255; header[5]=(bulk_remaining>>8)&255;
                header[6]=(bulk_remaining>>16)&255; header[7]=(bulk_remaining>>24)&255;
                if (write_control(0x82, 0, header, sizeof(header))) goto done;
            }
            available = bulk_remaining;
        }
        int got = 0, request = available > 32768 ? 32768 : (int)available;
        int rc = libusb_bulk_transfer(usb, 0x81, data + received, request, &got, 1000);
        received += got;
        if (automatic) bulk_remaining -= got;
        if (automatic) printf("Scan rows: %u end=%u (USB %s)\n", received / stride, end_line, libusb_error_name(rc));
        else printf("Image bytes: %u/%u (USB %s)\n", received, total, libusb_error_name(rc));
        if (rc || got == 0) break;
        if (automatic && !bulk_remaining && !end_line && received >= next_paper_check) {
            unsigned char high, middle, low;
            next_paper_check = received + stride * 64;
            if (read_reg(0x41, &byte)) goto done;
            if (byte & 8) {
                if (empty_count++ == 0) {
                    if (read_reg(0x4b, &high) || read_reg(0x4c, &middle) || read_reg(0x4d, &low)) goto done;
                    edge_line = ((high & 0x0f) << 16) | (middle << 8) | low;
                    edge_line = (edge_line + sensor_lines - 1) / sensor_lines;
                    printf("Paper edge candidate: hardware_row=%u received_row=%u\n", edge_line, received / stride);
                }
                if (empty_count >= 3) {
                    /* Sensor is upstream of the imaging line. Include a generous
                     * about 43 mm of image rows after its edge, and preserve 512-byte
                     * USB alignment by rounding the target to 64 image rows. */
                    end_line = ((edge_line + tail_rows + 63) / 64) * 64;
                    if (end_line < lines) goal_bytes = end_line * stride;
                    printf("Paper end confirmed: sensor_row=%u finish_row=%u\n", edge_line, end_line);
                }
            } else empty_count = 0;
        }
    }
    /* A variable-length scan stops before writing image files, while there
     * may still be a larger bulk request and line limit programmed in hardware. */
    printf("Capture timing: seconds=%.3f rows=%u bytes=%u\n",
           now() - capture_started, received / stride, received);
    if (stop()) goto done;
    {
        unsigned char high, middle, low;
        if (read_reg(0x4b, &high) || read_reg(0x4c, &middle) || read_reg(0x4d, &low)) goto done;
        printf("Finished sensor lines=%u channels=%u sides=%u output_rows=%u\n",
            ((high & 15) << 16) | (middle << 8) | low, channels, sides, received / stride);
    }
    if (received) {
        char raw[4096];
        if (snprintf(raw, sizeof(raw), "%s.raw", path) >= (int)sizeof(raw)) goto done;
        file = fopen(raw, "wb");
        if (!file) goto done;
        if (fwrite(data, 1, received, file) != received) goto done;
        if (fclose(file)) { file = NULL; goto done; } file = NULL;
    }
    if (received != goal_bytes) { fputs("Incomplete image transfer\n", stderr); goto done; }
    if (automatic && (!end_line || end_line > lines)) {
        fputs("Automatic scan limit reached before complete paper end; raw partial data saved\n", stderr); goto done;
    }
    if (automatic) lines = received / stride;
    for (unsigned page = 0; page < sides; ++page) {
        char back_path[4096];
        const char *output = path;
        if (page) {
            const char *ext = strrchr(path, '.'), *slash = strrchr(path, '/');
            int n;
            if (ext && (!slash || ext > slash))
                n = snprintf(back_path, sizeof(back_path), "%.*s-back%s", (int)(ext - path), path, ext);
            else n = snprintf(back_path, sizeof(back_path), "%s-back.%s", path, channels == 3 ? "ppm" : "pgm");
            if (n < 0 || (size_t)n >= sizeof(back_path)) goto done;
            output = back_path;
        }
        file = fopen(output, "wb");
        if (!file) goto done;
        if (fprintf(file, "P%u\n%u %u\n255\n", channels == 3 ? 6 : 5, width, lines) < 0) goto done;
        if (sides == 1) {
            if (fwrite(data, 1, received, file) != received) goto done;
        } else {
            unsigned char row[2480 * 3];
            for (unsigned y = 0; y < lines; ++y) {
                d600_duplex_row(row, data + y * stride, width, channels, page);
                if (fwrite(row, 1, width * channels, file) != width * channels) goto done;
            }
        }
        if (fclose(file)) { file = NULL; goto done; } file = NULL;
        printf("Saved %s page to %s\n", page ? "back" : "front", output);
    }
    printf("Saved uncalibrated %s image to %s\n", moving ? "moving" : "stationary", path);
    result = 0;
done:
    if (file) fclose(file);
    free(data);
    return result;
}
int main(int argc, char **argv)
{
    libusb_context *context = NULL;
    libusb_device **list = NULL, *target = NULL;
    ssize_t count, i;
    int matches = 0, result = 1, claimed = 0;
    int init = argc == 3 && !strcmp(argv[1], "--init");
    int feeding = argc == 3 && !strcmp(argv[1], "--feed");
    int reversing = argc == 3 && !strcmp(argv[1], "--reverse-feed");
    int ejecting = argc == 3 && !strcmp(argv[1], "--eject-tail");
    int capture = argc == 4 && !strcmp(argv[1], "--stationary");
    int scanning = argc == 4 && !strcmp(argv[1], "--scan");
    int automatic = argc == 4 && !strcmp(argv[1], "--scan-auto");
    int stopping = argc == 2 && !strcmp(argv[1], "--stop");
    int reading = argc == 2 && !strcmp(argv[1], "--status");
    int dumping = argc == 2 && !strcmp(argv[1], "--dump-registers");
    int watching = argc == 2 && !strcmp(argv[1], "--watch-buttons");
    setvbuf(stdout, NULL, _IOLBF, 0);
    if (!init && !capture && !stopping && !reading && !dumping && !watching && !feeding && !reversing && !ejecting && !scanning && !automatic) {
        puts("Usage: d600-experiment --status | --dump-registers | --watch-buttons | --stop | --init profile.json | --feed profile.json | --reverse-feed profile.json | --eject-tail profile.json | --stationary profile.json output.pgm | --scan profile.json output.pgm | --scan-auto profile.json output.pgm");
        return 2;
    }
    signal(SIGINT, on_signal); signal(SIGTERM, on_signal);
    if (libusb_init(&context)) return 1;
    count = libusb_get_device_list(context, &list);
    if (count < 0) goto done;
    for (i = 0; i < count; ++i) {
        struct libusb_device_descriptor d;
        if (!libusb_get_device_descriptor(list[i], &d) && d.idVendor == 0x07b3 && d.idProduct == 0x0c27) {
            ++matches;
            if (d.bcdDevice == 0x0500) target = list[i];
        }
    }
    if (matches != 1 || !target) { fputs("Expected exactly one D600 revision 0500\n", stderr); goto done; }
    if (libusb_open(target, &usb)) { fputs("Cannot open D600\n", stderr); goto done; }
    { int rc = libusb_claim_interface(usb, 0);
      /* macOS may publish the interface asynchronously after its first claim. */
      if (rc == LIBUSB_ERROR_NOT_FOUND) { delay_ms(250); rc = libusb_claim_interface(usb, 0); }
      if (rc) { fprintf(stderr, "Claim interface: %s\n", libusb_error_name(rc)); goto done; } }
    claimed = 1;
    if (reading) result = status() ? 1 : 0;
    else if (watching) result = watch_buttons() ? 1 : 0;
    else if (dumping) result = dump_registers() ? 1 : 0;
    else if (stopping) result = stop() ? 1 : 0;
    else if (!initialize(argv[2]) && !interrupted)
        result = (feeding || reversing || ejecting) ? (feed(reversing, ejecting) ? 1 : 0) : (capture || scanning || automatic) ? (acquire(argv[3], scanning || automatic, automatic) ? 1 : 0) : 0;
done:
    if (usb && dirty && !stopping && stop()) result = 1;
    if (claimed) libusb_release_interface(usb, 0);
    if (usb) libusb_close(usb);
    if (list) libusb_free_device_list(list, 1);
    libusb_exit(context);
    if (interrupted) result = 128 + interrupted;
    return result;
}
