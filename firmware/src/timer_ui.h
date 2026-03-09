// ==========================================================================
//  QBIT -- Countdown timer UI (set screen + running screen)
// ==========================================================================
#ifndef TIMER_UI_H
#define TIMER_UI_H

#include <Arduino.h>

// Gesture type for input (matches app_state GestureType for display_task use)
enum class TimerGestureType {
    None, SingleTap, DoubleTap, LongPress
};

// Action returned from gesture handlers; display_task performs the state transition
enum class TimerAction {
    None,     // no action
    Redraw,   // caller should redraw (set or running)
    Start,    // set: start countdown -> caller enters TIMER_RUNNING
    Back,     // return to settings
    Dismiss,  // running: user dismissed alarm -> caller enters GIF_PLAYBACK
    GoToSet   // running: user requested back to set screen
};

// Reset state for set timer screen. Call when entering TIMER_SET; caller then calls timerUiDrawSet().
void timerUiEnterSet();

// Draw set screen (HH:MM:SS with field highlight). Uses module state.
void timerUiDrawSet();

// Draw running screen. Call with current remainSec and started flag.
void timerUiDrawRunning(uint32_t remainSec, bool started);

// Handle gesture on set screen. Returns action; display_task applies and calls enterState as needed.
TimerAction timerUiOnGestureSet(TimerGestureType g);

// Handle gesture on running screen (before done: cancel; when done: dismiss).
TimerAction timerUiOnGestureRunning(TimerGestureType g, bool done, bool started);

// Tick running timer. Updates internal state; returns true if display should redraw (remainSec or done changed).
bool timerUiTick(unsigned long nowMs);

// Getters for display_task
uint8_t  timerUiGetHours();
uint8_t  timerUiGetMinutes();
uint8_t  timerUiGetSeconds();
uint8_t  timerUiGetField();
uint32_t timerUiGetRemainSec();
bool     timerUiGetStarted();
bool     timerUiGetDone();

// When user taps "start" in running screen, caller sets started and lastTickMs
void timerUiSetStarted(bool started);
void timerUiSetLastTickMs(unsigned long ms);

#endif // TIMER_UI_H
