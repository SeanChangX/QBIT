// ==========================================================================
//  QBIT -- Input task (touch gesture state machine)
// ==========================================================================
#include "input_task.h"
#include "app_state.h"
#include "settings.h"
#include <Arduino.h>

// Gesture state machine
enum TouchState {
    TOUCH_IDLE,
    TOUCH_TOUCHED,
    TOUCH_WAIT_SECOND_TAP
};

#define LONG_PRESS_MS      1500
#define DOUBLE_TAP_WINDOW  300
#define POLL_INTERVAL_MS   10

void inputTask(void *param) {
    (void)param;

    TouchState state = TOUCH_IDLE;
    unsigned long touchDownMs = 0;
    unsigned long releaseMs   = 0;

    for (;;) {
        bool pinHigh = (digitalRead(getPinTouch()) == HIGH);
        unsigned long now = millis();

        switch (state) {
            case TOUCH_IDLE:
                if (pinHigh) {
                    state = TOUCH_TOUCHED;
                    touchDownMs = now;
                    // Immediate touch feedback
                    GestureEvent tdEvt = { TOUCH_DOWN, now };
                    xQueueSend(gestureQueue, &tdEvt, 0);
                }
                break;

            case TOUCH_TOUCHED:
                if (pinHigh) {
                    // Still held — check for long press
                    if (now - touchDownMs >= LONG_PRESS_MS) {
                        GestureEvent evt = { LONG_PRESS, now };
                        xQueueSend(gestureQueue, &evt, 0);
                        // Wait for release
                        while (digitalRead(getPinTouch()) == HIGH) {
                            vTaskDelay(pdMS_TO_TICKS(POLL_INTERVAL_MS));
                        }
                        state = TOUCH_IDLE;
                    }
                } else {
                    // Released — was it a short tap?
                    unsigned long held = now - touchDownMs;
                    if (held < DOUBLE_TAP_WINDOW) {
                        // Short tap — wait for possible second tap
                        state = TOUCH_WAIT_SECOND_TAP;
                        releaseMs = now;
                    } else {
                        // Longer than double-tap window but shorter than long press
                        GestureEvent evt = { SINGLE_TAP, now };
                        xQueueSend(gestureQueue, &evt, 0);
                        state = TOUCH_IDLE;
                    }
                }
                break;

            case TOUCH_WAIT_SECOND_TAP:
                if (pinHigh) {
                    // Second tap detected within window
                    GestureEvent evt = { DOUBLE_TAP, now };
                    xQueueSend(gestureQueue, &evt, 0);
                    // Wait for release
                    while (digitalRead(getPinTouch()) == HIGH) {
                        vTaskDelay(pdMS_TO_TICKS(POLL_INTERVAL_MS));
                    }
                    state = TOUCH_IDLE;
                } else if (now - releaseMs >= DOUBLE_TAP_WINDOW) {
                    // Timeout — it was a single tap
                    GestureEvent evt = { SINGLE_TAP, now };
                    xQueueSend(gestureQueue, &evt, 0);
                    state = TOUCH_IDLE;
                }
                break;
        }

        vTaskDelay(pdMS_TO_TICKS(POLL_INTERVAL_MS));
    }
}
