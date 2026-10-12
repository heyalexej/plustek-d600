#!/bin/sh
# Collect identification data without sending scanner-specific commands.
set -eu

case "${1-}" in
    --help|-h)
        printf '%s\n' 'Usage: sh tools/probe-linux.sh [> d600-probe.txt]' \
            'Run on the Linux host with the scanner attached and powered on.' \
            'Reads system information and USB descriptors; does not scan or calibrate.'
        exit 0
        ;;
    '') ;;
    *) printf '%s\n' 'Unexpected argument; use --help.' >&2; exit 2 ;;
esac

if [ "$(uname -s)" != Linux ]; then
    printf '%s\n' 'Run this script on the target Linux machine.' >&2
    exit 1
fi

section() { printf '\n== %s ==\n' "$1"; }

section 'System'
uname -a
for release in /etc/os-release /etc/lsb-release /etc/debian_version /etc/redhat-release; do
    if [ -r "$release" ]; then
        printf '\n%s\n' "$release"
        cat "$release"
    fi
done
if command -v getconf >/dev/null 2>&1; then
    getconf LONG_BIT 2>/dev/null || :
    getconf GNU_LIBC_VERSION 2>/dev/null || :
fi

section 'Available tools'
for tool in lsusb scanimage sane-find-scanner pkg-config cc gcc; do
    command -v "$tool" || :
done
if command -v scanimage >/dev/null 2>&1; then
    scanimage --version 2>&1 || :
fi
if command -v pkg-config >/dev/null 2>&1; then
    pkg-config --modversion libusb-1.0 2>/dev/null || :
fi

section 'Plustek devices from Linux sysfs'
found=0
for device in /sys/bus/usb/devices/*; do
    [ -r "$device/idVendor" ] || continue
    [ "$(cat "$device/idVendor")" = 07b3 ] || continue
    found=1
    printf '\nDevice: %s\n' "$device"
    for attr in idVendor idProduct bcdDevice manufacturer product busnum devnum speed bNumConfigurations; do
        if [ -r "$device/$attr" ]; then
            printf '%s: ' "$attr"
            cat "$device/$attr"
        fi
    done
    if [ -r "$device/descriptors" ]; then
        printf '%s\n' 'Cached USB descriptors (hex):'
        od -An -tx1 -v "$device/descriptors" || :
    fi
done
if [ "$found" = 0 ]; then
    printf '%s\n' 'No Plustek device found in sysfs. Check power and USB connection.'
fi

section 'USB device list and D600 descriptors'
if command -v lsusb >/dev/null 2>&1; then
    lsusb || :
    lsusb -v -d 07b3:0c27 2>&1 || :
else
    printf '%s\n' 'lsusb is unavailable; sysfs results above may still identify the device.'
fi

printf '\n%s\n' 'Probe finished. No scan, calibration, reset, or firmware upload was requested.'
