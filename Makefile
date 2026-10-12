CC ?= cc
PKG_CONFIG ?= pkg-config
CFLAGS ?= -O2 -g
USB_CFLAGS := $(shell $(PKG_CONFIG) --cflags libusb-1.0)
USB_LIBS := $(shell $(PKG_CONFIG) --libs libusb-1.0)

.PHONY: all profiles ui test-ui test-native
all: artifacts/bin/d600-probe artifacts/bin/d600-experiment

profiles:
	node tools/build-profiles.mjs

ui: all profiles
	node ui/server.mjs

test-ui:
	node --test test/*.test.mjs

test-native: artifacts/bin/test-image artifacts/bin/test-timing
	artifacts/bin/test-image
	artifacts/bin/test-timing

artifacts/bin/test-timing: test/timing.test.c src/d600-timing.h
	mkdir -p artifacts/bin
	$(CC) $(CPPFLAGS) $(CFLAGS) -std=c99 -Wall -Wextra -Werror $< -lm -o $@

artifacts/bin/test-image: test/image.test.c src/d600-image.h
	mkdir -p artifacts/bin
	$(CC) $(CPPFLAGS) $(CFLAGS) -std=c99 -Wall -Wextra -Werror $< -o $@

artifacts/bin/d600-probe: src/d600-probe.c
	mkdir -p artifacts/bin
	$(CC) $(CPPFLAGS) $(CFLAGS) -std=c99 -Wall -Wextra -Werror $(USB_CFLAGS) $< $(LDFLAGS) $(USB_LIBS) -o $@

artifacts/bin/d600-experiment: src/d600-experiment.c src/d600-image.h src/d600-timing.h
	mkdir -p artifacts/bin
	$(CC) $(CPPFLAGS) $(CFLAGS) -std=c99 -Wall -Wextra -Werror $(USB_CFLAGS) $< $(LDFLAGS) $(USB_LIBS) -lm -o $@
