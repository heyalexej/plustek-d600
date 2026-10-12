#ifndef D600_TIMING_H
#define D600_TIMING_H
#include <math.h>

/* Quarter-step transport, 30 MHz system clock, 400 ns motor timer ticks.
 * Build the 256-entry power-law acceleration curve and clamp at scan speed. */
static unsigned d600_motor_curve(unsigned short table[256], unsigned target)
{
    unsigned i, reached = 255;
    unsigned first_speed = (unsigned)(22720.0 * pow(1.0 / 255.0, 100.0 / 210.0));
    for (i = 0; i < 256; ++i) {
        unsigned speed = i ? (unsigned)(22720.0 * pow((double)i / 255.0, 100.0 / 210.0)) : first_speed / 2;
        unsigned interval = 2500000U / (speed ? speed : 1);
        if (interval <= target && reached == 255) reached = i;
        table[i] = (unsigned short)(interval > target ? interval : target);
    }
    /* Include the first target-speed entry; hardware count is 1..255. */
    return reached < 254 ? reached + 1 : 255;
}
#endif
