#ifndef D600_IMAGE_H
#define D600_IMAGE_H

/* Hardware-confirmed D600 duplex FIFO: two width-sized blocks. RGB green
 * belongs to the opposite block. Block 1 is the
 * face-down sensor; block 0 looks across the sheet and must be mirrored. */
static void d600_duplex_row(unsigned char *output, const unsigned char *input,
                           unsigned width, unsigned channels, unsigned back)
{
    unsigned x, c;
    for (x = 0; x < width; ++x) {
        unsigned source_x = back ? width - 1 - x : x;
        for (c = 0; c < channels; ++c) {
            unsigned block = back ? 0 : 1;
            if (channels == 3 && c == 1) block = 1 - block;
            output[x * channels + c] = input[(block * width + source_x) * channels + c];
        }
    }
}
#endif
