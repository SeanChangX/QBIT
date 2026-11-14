// ==========================================================================
//  QBIT -- Pomodoro "Focus Time" UI implementation
// ==========================================================================
#include "pomodoro_ui.h"
#include "app_state.h"
#include "display_helpers.h"
#include <stdio.h>

// ==========================================================================
//  Session durations (seconds)
// ==========================================================================
#define POM_FOCUS_SEC      (25u * 60u)   // 25 min
#define POM_SHORT_BREAK    ( 5u * 60u)   //  5 min
#define POM_LONG_BREAK     (15u * 60u)   // 15 min

// ==========================================================================
//  Module state
// ==========================================================================
static PomMode   _mode        = PomMode::Focus;
static uint8_t   _focusCount  = 0;       // completed focus rounds (0-3)
static uint32_t  _remainSec   = 0;
static unsigned long _lastTickMs = 0;
static uint32_t  _lastDisplaySec = UINT32_MAX;
static bool      _done        = false;
static bool      _started     = false;

// ==========================================================================
//  Helpers
// ==========================================================================

static const char *modeLabel(PomMode m) {
    switch (m) {
        case PomMode::Focus:      return "Focus";
        case PomMode::ShortBreak: return "Short Break";
        case PomMode::LongBreak:  return "Long Break";
    }
    return "";
}

static uint32_t modeDuration(PomMode m) {
    switch (m) {
        case PomMode::Focus:      return POM_FOCUS_SEC;
        case PomMode::ShortBreak: return POM_SHORT_BREAK;
        case PomMode::LongBreak:  return POM_LONG_BREAK;
    }
    return POM_FOCUS_SEC;
}

// ==========================================================================
//  Select screen
// ==========================================================================

void pomUiEnterSelect() {
    _mode       = PomMode::Focus;
    _started    = false;
    _done       = false;
    _focusCount = 0;
}

void pomUiDrawSelect() {
    u8g2.clearBuffer();

    // ---- Title ----
    u8g2.setFont(u8g2_font_6x13_tr);
    const char *hdr = "[ Focus Time ]";
    u8g2.drawStr((128 - u8g2.getStrWidth(hdr)) / 2, 12, hdr);

    // ---- Mode label (highlighted with rounded frame) ----
    const char *label = modeLabel(_mode);
    uint8_t lw = u8g2.getStrWidth(label);
    int16_t lx = (128 - (int16_t)lw) / 2;

    // Frame around the mode name
    u8g2.drawRFrame((uint8_t)(lx - 6), 16, (uint8_t)(lw + 12), 16, 3);
    u8g2.drawStr((uint8_t)lx, 29, label);

    // ---- Duration (large numeric, inside a frame) ----
    uint32_t dur = modeDuration(_mode);
    uint8_t mm = (uint8_t)(dur / 60);
    uint8_t ss = (uint8_t)(dur % 60);

    char timeBuf[6];
    snprintf(timeBuf, sizeof(timeBuf), "%02d:%02d", mm, ss);

    u8g2.setFont(u8g2_font_logisoso18_tn);
    uint8_t tw = u8g2.getStrWidth(timeBuf);
    int16_t tx = (128 - (int16_t)tw) / 2;
    const int16_t ty = 52;

    // Outer frame around the timer digits
    uint8_t fh = u8g2.getMaxCharHeight();
    u8g2.drawRFrame((uint8_t)(tx - 8), (uint8_t)(ty - fh), (uint8_t)(tw + 16), (uint8_t)(fh + 6), 4);
    u8g2.drawStr((uint8_t)tx, ty, timeBuf);

    // ---- Hint ----
    u8g2.setFont(u8g2_font_5x7_tr);
    const char *hint = "TAP:mode  HOLD:start";
    u8g2.drawStr((128 - u8g2.getStrWidth(hint)) / 2, 63, hint);

    rotateBuffer180();
    u8g2.sendBuffer();
}

PomAction pomUiOnGestureSelect(PomGestureType g) {
    if (g == PomGestureType::SingleTap) {
        // Cycle: Focus → ShortBreak → LongBreak → Focus
        uint8_t m = (uint8_t)_mode;
        _mode = (PomMode)((m + 1) % 3);
        return PomAction::Redraw;
    }
    if (g == PomGestureType::LongPress) {
        // Start the selected session
        _remainSec = modeDuration(_mode);
        _lastDisplaySec = UINT32_MAX;
        _done = false;
        _started = false;
        return PomAction::Start;
    }
    if (g == PomGestureType::DoubleTap) {
        return PomAction::Back;
    }
    return PomAction::None;
}

// ==========================================================================
//  Running screen
// ==========================================================================

void pomUiDrawRunning(uint32_t remainSec, bool started) {
    uint8_t mm = (uint8_t)(remainSec / 60);
    uint8_t ss = (uint8_t)(remainSec % 60);

    char timeBuf[6];
    snprintf(timeBuf, sizeof(timeBuf), "%02d:%02d", mm, ss);

    u8g2.clearBuffer();

    // ---- Title ----
    u8g2.setFont(u8g2_font_6x13_tr);
    const char *hdr = modeLabel(_mode);
    char titleBuf[24];
    snprintf(titleBuf, sizeof(titleBuf), "[ %s ]", hdr);
    u8g2.drawStr((128 - u8g2.getStrWidth(titleBuf)) / 2, 12, titleBuf);

    // ---- Timer digits inside a frame ----
    u8g2.setFont(u8g2_font_logisoso22_tn);
    uint8_t tw = u8g2.getStrWidth(timeBuf);
    int16_t tx = (128 - (int16_t)tw) / 2;
    const int16_t ty = 46;

    uint8_t fh = u8g2.getMaxCharHeight();
    // Draw rounded frame around digits
    u8g2.drawRFrame((uint8_t)(tx - 10), (uint8_t)(ty - fh), (uint8_t)(tw + 20), (uint8_t)(fh + 6), 4);
    u8g2.drawStr((uint8_t)tx, ty, timeBuf);

    // ---- Focus round indicator (dots: ● ○ ○ ○) ----
    if (_mode == PomMode::Focus || _mode == PomMode::ShortBreak) {
        int16_t dotStartX = (128 - (4 * 6 + 3 * 4)) / 2;  // 4 dots, 3 gaps
        for (uint8_t i = 0; i < 4; i++) {
            int16_t cx = dotStartX + i * 10 + 3;
            if (i < _focusCount) {
                u8g2.drawDisc(cx, 56, 3);   // filled
            } else {
                u8g2.drawCircle(cx, 56, 3); // hollow
            }
        }
    }

    // ---- Hint line ----
    u8g2.setFont(u8g2_font_5x7_tr);
    const char *hint = started ? "DBL:exit" : "TAP:start";
    u8g2.drawStr((128 - u8g2.getStrWidth(hint)) / 2, 63, hint);

    rotateBuffer180();
    u8g2.sendBuffer();
}

PomAction pomUiOnGestureRunning(PomGestureType g, bool done, bool started) {
    if (done) {
        // Any gesture dismisses the alarm
        if (g == PomGestureType::SingleTap || g == PomGestureType::DoubleTap ||
            g == PomGestureType::LongPress) {
            return PomAction::Dismiss;
        }
        return PomAction::None;
    }
    if (!started) {
        // Not yet started: tap starts, double-tap exits
        if (g == PomGestureType::SingleTap)
            return PomAction::Redraw;   // caller will set started and redraw
        if (g == PomGestureType::DoubleTap)
            return PomAction::Back;
        return PomAction::None;
    }
    // Running: double-tap or long-press exits
    if (g == PomGestureType::DoubleTap || g == PomGestureType::LongPress)
        return PomAction::Dismiss;
    return PomAction::None;
}

// ==========================================================================
//  Tick
// ==========================================================================

bool pomUiTick(unsigned long nowMs) {
    if (!_started || _done) return false;
    if (nowMs - _lastTickMs < 1000) return false;

    unsigned long ticks = (nowMs - _lastTickMs) / 1000;
    if (ticks > _remainSec) ticks = _remainSec;
    _remainSec -= (uint32_t)ticks;
    _lastTickMs += ticks * 1000;

    if (_remainSec == 0) {
        _done = true;
        _lastDisplaySec = 0;

        // Track completed focus rounds
        if (_mode == PomMode::Focus) {
            _focusCount++;
            if (_focusCount >= 4) _focusCount = 0;
        }
        return true;
    }
    if (_remainSec != _lastDisplaySec) {
        _lastDisplaySec = _remainSec;
        return true;
    }
    return false;
}

// ==========================================================================
//  Getters / Setters
// ==========================================================================

PomMode  pomUiGetMode()       { return _mode; }
uint32_t pomUiGetRemainSec()  { return _remainSec; }
bool     pomUiGetStarted()    { return _started; }
bool     pomUiGetDone()       { return _done; }
uint8_t  pomUiGetFocusCount() { return _focusCount; }

void pomUiSetStarted(bool started) { _started = started; }
void pomUiSetLastTickMs(unsigned long ms) { _lastTickMs = ms; }
