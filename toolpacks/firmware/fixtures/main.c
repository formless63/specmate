/* SPDX-License-Identifier: AGPL-3.0-only
 * Original synthetic compiler fixture. No device behavior is qualified.
 */
#include <stdint.h>
volatile uint8_t counter;
int main(void) {
    counter = COUNT;
    for (;;) {
        counter++;
    }
}
