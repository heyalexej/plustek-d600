#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "../src/d600-image.h"

int main(void)
{
    const unsigned char gray[] = {10, 20, 30, 40};
    const unsigned char rgb[] = {1, 2, 3, 4, 5, 6, 11, 12, 13, 14, 15, 16};
    const unsigned char front[] = {11, 2, 13, 14, 5, 16};
    const unsigned char back[] = {4, 15, 6, 1, 12, 3};
    unsigned char out[8];
    memset(out, 0xee, sizeof(out));
    d600_duplex_row(out, gray, 2, 1, 0);
    assert(out[0] == 30 && out[1] == 40 && out[2] == 0xee);
    d600_duplex_row(out, gray, 2, 1, 1);
    assert(out[0] == 20 && out[1] == 10 && out[2] == 0xee);
    d600_duplex_row(out, rgb, 2, 3, 0);
    assert(memcmp(out, front, 6) == 0 && out[6] == 0xee);
    d600_duplex_row(out, rgb, 2, 3, 1);
    assert(memcmp(out, back, 6) == 0 && out[6] == 0xee);
    puts("Duplex grayscale/RGB separation, green-channel routing and mirroring passed.");
    return 0;
}
