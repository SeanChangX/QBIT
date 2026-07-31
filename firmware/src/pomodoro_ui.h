// ==========================================================================
//  QBIT -- Pomodoro "Focus Time" UI (mode select + countdown)
// ==========================================================================
#ifndef POMODORO_UI_H
#define POMODORO_UI_H

#include <Arduino.h>

// Gesture type for input (mirrors timer_ui convention)
enum class PomGestureType {
    None, SingleTap, DoubleTap, LongPress
};

// Action returned from gesture handlers; display_task performs the transition
enum class PomAction {
    None,       // no action
    Redraw,     // caller should redraw the current screen
    Start,      // select: start countdown → caller enters POMODORO_RUNNING
    Back,       // return to settings menu
    Dismiss     // running: user dismissed alarm → caller enters GIF_PLAYBACK
};

// Pomodoro session kinds
enum class PomMode : uint8_t {
    Focus      = 0,   // 25 min
    ShortBreak = 1,   //  5 min
    LongBreak  = 2    // 15 min (after 4 focus rounds)
};

// ---------- Select screen ----------

// Reset state and enter mode-select screen.
void pomUiEnterSelect();

// Draw the mode-select screen.
void pomUiDrawSelect();

// Handle gesture on select screen.
PomAction pomUiOnGestureSelect(PomGestureType g);

// ---------- Running screen ----------

// Draw running countdown. Called from display_task tick.
void pomUiDrawRunning(uint32_t remainSec, bool started);

// Handle gesture on running screen.
PomAction pomUiOnGestureRunning(PomGestureType g, bool done, bool started);

// Tick the countdown. Returns true when display should redraw.
bool pomUiTick(unsigned long nowMs);

// ---------- Getters ----------
PomMode  pomUiGetMode();
uint32_t pomUiGetRemainSec();
bool     pomUiGetStarted();
bool     pomUiGetDone();
uint8_t  pomUiGetFocusCount();   // completed focus rounds (0-3)

// ---------- Setters (called by display_task) ----------
void pomUiSetStarted(bool started);
void pomUiSetLastTickMs(unsigned long ms);

#endif // POMODORO_UI_H
