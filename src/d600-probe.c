/* D600 identification and read-only USB status requests.
 * Status request: value 0x8e, length 1, index 0.
 * Register reads select an address; they never write register values.
 * No scan, motor, calibration, firmware or reset operations.
 */
#include <libusb.h>
#include <stdio.h>
#include <string.h>

static int read_register(libusb_device_handle *handle, unsigned char address,
                         unsigned char *value)
{
    unsigned char ack = 0;
    int result;
    /* Select a register, await acknowledgement, then read it. */
    result = libusb_control_transfer(handle, 0x40, 0x0c, 0x83, 0,
                                     &address, 1, 2000);
    if (result != 1)
        return result < 0 ? result : LIBUSB_ERROR_IO;
    result = libusb_control_transfer(handle, 0xc0, 0x0c, 0x8e, 0x20,
                                     &ack, 1, 2000);
    if (result != 1)
        return result < 0 ? result : LIBUSB_ERROR_IO;
    if (!(ack & 1)) {
        fprintf(stderr, "Register selector was not acknowledged (0x%02x).\n", ack);
        return LIBUSB_ERROR_IO;
    }
    result = libusb_control_transfer(handle, 0xc0, 0x0c, 0x84, 0,
                                     value, 1, 2000);
    return result == 1 ? 0 : (result < 0 ? result : LIBUSB_ERROR_IO);
}

static int describe(libusb_device *device,
                    const struct libusb_device_descriptor *desc)
{
    struct libusb_config_descriptor *config = NULL;
    unsigned int c;
    int result;

    printf("D600 %04x:%04x bcdDevice=%04x bus=%u address=%u\n",
           desc->idVendor, desc->idProduct, desc->bcdDevice,
           libusb_get_bus_number(device), libusb_get_device_address(device));
    for (c = 0; c < desc->bNumConfigurations; ++c) {
        unsigned int i;
        result = libusb_get_config_descriptor(device, (uint8_t)c, &config);
        if (result < 0) {
            fprintf(stderr, "Configuration: %s\n", libusb_error_name(result));
            return 1;
        }
        printf("configuration=%u interfaces=%u\n",
               config->bConfigurationValue, config->bNumInterfaces);
        for (i = 0; i < config->bNumInterfaces; ++i) {
            int a;
            for (a = 0; a < config->interface[i].num_altsetting; ++a) {
                const struct libusb_interface_descriptor *iface =
                    &config->interface[i].altsetting[a];
                unsigned int e;
                printf("  interface=%u alternate=%u class=%02x\n",
                       iface->bInterfaceNumber, iface->bAlternateSetting,
                       iface->bInterfaceClass);
                for (e = 0; e < iface->bNumEndpoints; ++e) {
                    const struct libusb_endpoint_descriptor *ep = &iface->endpoint[e];
                    printf("    endpoint=%02x direction=%s type=%u maxpacket=%u\n",
                           ep->bEndpointAddress,
                           (ep->bEndpointAddress & LIBUSB_ENDPOINT_IN) ? "IN" : "OUT",
                           ep->bmAttributes & LIBUSB_TRANSFER_TYPE_MASK,
                           ep->wMaxPacketSize);
                }
            }
        }
        libusb_free_config_descriptor(config);
    }
    return 0;
}

int main(int argc, char **argv)
{
    libusb_context *context = NULL;
    libusb_device **devices = NULL;
    libusb_device *target = NULL;
    libusb_device_handle *handle = NULL;
    struct libusb_device_descriptor target_desc;
    ssize_t count, i;
    int result, matches = 0, exit_code = 1;
    int read_status = argc == 2 && strcmp(argv[1], "--status") == 0;
    int read_registers = argc == 2 && strcmp(argv[1], "--registers") == 0;

    setvbuf(stdout, NULL, _IOLBF, 0);
    if (argc == 2 && strcmp(argv[1], "--help") == 0) {
        puts("Usage: d600-probe [--status | --registers]");
        puts("Default: identify D600 USB interfaces and endpoints.");
        puts("--status: additionally read one byte using recovered request c0/0c/008e/0000.");
        puts("--registers: also select and read nine diagnostic registers (revision 0500 only).");
        return 0;
    }
    if (argc > 2 || (argc == 2 && !read_status && !read_registers)) {
        fputs("Unknown option; use --help.\n", stderr);
        return 2;
    }
    result = libusb_init(&context);
    if (result < 0) {
        fprintf(stderr, "libusb_init: %s\n", libusb_error_name(result));
        return 1;
    }
    count = libusb_get_device_list(context, &devices);
    if (count < 0) {
        fprintf(stderr, "USB enumeration: %s\n", libusb_error_name((int)count));
        goto done;
    }
    for (i = 0; i < count; ++i) {
        struct libusb_device_descriptor desc;
        if (libusb_get_device_descriptor(devices[i], &desc) == 0 &&
            desc.idVendor == 0x07b3 && desc.idProduct == 0x0c27) {
            target = devices[i];
            target_desc = desc;
            ++matches;
        }
    }
    if (matches != 1) {
        fprintf(stderr, "Expected one D600 (07b3:0c27), found %d.\n", matches);
        goto done;
    }
    if (describe(target, &target_desc) != 0)
        goto done;
    if (!read_status && !read_registers) {
        exit_code = 0;
        goto done;
    }
    if (target_desc.bcdDevice < 0x0200) {
        fputs("Driver does not use this request on revisions below 0200.\n", stderr);
        goto done;
    }
    if (read_registers && target_desc.bcdDevice != 0x0500) {
        fputs("Register probe is restricted to the observed revision 0500.\n", stderr);
        goto done;
    }
    result = libusb_open(target, &handle);
    if (result < 0) {
        fprintf(stderr, "Open D600: %s\n", libusb_error_name(result));
        goto done;
    }
    {
        unsigned char status = 0;
        puts("Reading c0/0c value=008e index=0000 length=1 timeout=2000ms...");
        result = libusb_control_transfer(handle, 0xc0, 0x0c, 0x008e, 0x0000,
                                         &status, 1, 2000);
        if (result != 1) {
            if (result < 0)
                fprintf(stderr, "Status read: %s\n", libusb_error_name(result));
            else
                fprintf(stderr, "Status read: expected 1 byte, received %d.\n", result);
            goto done;
        }
        printf("raw_status=0x%02x bit3=%u (Genesys USB link-mode flag)\n",
               status, (status >> 3) & 1);
    }
    if (read_registers) {
        const unsigned char addresses[] = {1, 2, 3, 4, 5, 6, 0x41, 0x6c, 0x6d};
        size_t r;
        for (r = 0; r < sizeof(addresses); ++r) {
            unsigned char value = 0;
            printf("Reading register 0x%02x...\n", addresses[r]);
            result = read_register(handle, addresses[r], &value);
            if (result != 0) {
                fprintf(stderr, "Register read: %s\n", libusb_error_name(result));
                goto done;
            }
            printf("register[0x%02x]=0x%02x\n", addresses[r], value);
        }
    }
    exit_code = 0;
done:
    if (handle)
        libusb_close(handle);
    if (devices)
        libusb_free_device_list(devices, 1);
    libusb_exit(context);
    return exit_code;
}
