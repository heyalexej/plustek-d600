#include <assert.h>
#include <stdio.h>
#include "../src/d600-timing.h"
int main(void)
{
    unsigned short table[256];
    unsigned i;
    assert(d600_motor_curve(table, 8400) == 1);
    for (i = 0; i < 256; ++i) assert(table[i] == 8400);
    assert(d600_motor_curve(table, 2100) == 2);
    assert(table[0] == 3082 && table[1] == 2100 && table[255] == 2100);
    assert(d600_motor_curve(table, 700) == 7);
    assert(table[0] == 3082 && table[1] == 1540 && table[2] == 1107);
    assert(table[5] == 715 && table[6] == 700 && table[255] == 700);
    for (i = 1; i < 256; ++i) assert(table[i] <= table[i-1]);
    puts("Motor acceleration vectors and target-speed clamping passed.");
    return 0;
}
