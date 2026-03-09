// ==========================================================================
//  QBIT -- Countdown timer UI implementation
// ==========================================================================
#include "timer_ui.h"
#include "app_state.h"
#include "display_helpers.h"
#include <stdio.h>

static uint8_t  _hours   = 0;
static uint8_t  _minutes = 0;
static uint8_t  _seconds = 0;
static uint8_t  _field   = 0;  // 0=HH, 1=MM, 2=SS
static uint32_t _remainSec   = 0;
static unsigned long _lastTickMs     = 0;
static uint32_t _lastDisplaySec = UINT32_MAX;
static bool     _done    = false;
static bool     _started = false;

void timerUiEnterSet() {
    _hours   = 0;
    _minutes = 0;
    _seconds = 0;
    _field   = 0;
    _started = false;
    _done    = false;
}

void timerUiDrawSet() {
    u8g2.clearBuffer();

    u8g2.setFont(u8g2_font_6x13_tr);
    const char *hdr = "[ Set Timer ]";
    u8g2.drawStr((128 - u8g2.getStrWidth(hdr)) / 2, 12, hdr);

    u8g2.setFont(u8g2_font_logisoso28_tn);
    char buf[9];
    snprintf(buf, sizeof(buf), "%02d:%02d:%02d", _hours, _minutes, _seconds);

    uint8_t tw = u8g2.getStrWidth(buf);
    int16_t tx = (128 - tw) / 2;
    const int16_t ty = 48;

    char hhStr[3], mmStr[3], ssStr[3], prefixBuf[12];
    snprintf(hhStr, sizeof(hhStr), "%02d", _hours);
    snprintf(mmStr, sizeof(mmStr), "%02d", _minutes);
    snprintf(ssStr, sizeof(ssStr), "%02d", _seconds);
    uint8_t wHH = u8g2.getStrWidth(hhStr);
    uint8_t wMM = u8g2.getStrWidth(mmStr);
    uint8_t wSS = u8g2.getStrWidth(ssStr);

    // Same logic for HH, MM, SS: start = first digit of field (after ':' for MM/SS), width = two digits.
    int16_t fieldStartX[3];
    uint8_t fieldWidth[3] = { wHH, wMM, wSS };
    fieldStartX[0] = tx;
    snprintf(prefixBuf, sizeof(prefixBuf), "%02d:", _hours);
    fieldStartX[1] = tx + (int16_t)u8g2.getStrWidth(prefixBuf);
    snprintf(prefixBuf, sizeof(prefixBuf), "%02d:%02d:", _hours, _minutes);
    fieldStartX[2] = tx + (int16_t)u8g2.getStrWidth(prefixBuf);

    uint8_t fh = u8g2.getMaxCharHeight();
    // Box: 4px less on top/left; right/bottom unchanged. Then +1px left of digits, -1px right of digits.
    int16_t boxX = fieldStartX[_field] + 1;
    int16_t boxY = ty - (int16_t)fh + 2;
    uint8_t boxW = (uint8_t)((int16_t)fieldWidth[_field] + 1);
    uint8_t boxH = fh;

    u8g2.setDrawColor(1);
    u8g2.drawStr(tx, ty, buf);

    u8g2.setDrawColor(2);
    u8g2.drawBox(boxX, boxY, boxW, boxH);

    u8g2.setFont(u8g2_font_6x13_tr);
    u8g2.setDrawColor(1);
    const char *hint = (_field < 2) ? "TAP:+1  HOLD:next"
                                    : "TAP:+1  HOLD:start";
    u8g2.drawStr((128 - u8g2.getStrWidth(hint)) / 2, 62, hint);

    rotateBuffer180();
    u8g2.sendBuffer();
}

void timerUiDrawRunning(uint32_t remainSec, bool started) {
    uint8_t h = (uint8_t)(remainSec / 3600);
    uint8_t m = (uint8_t)((remainSec % 3600) / 60);
    uint8_t s = (uint8_t)(remainSec % 60);

    char buf[9];
    snprintf(buf, sizeof(buf), "%02d:%02d:%02d", h, m, s);

    u8g2.clearBuffer();

    u8g2.setFont(u8g2_font_6x13_tr);
    const char *hdr = "[ Timer ]";
    u8g2.drawStr((128 - u8g2.getStrWidth(hdr)) / 2, 12, hdr);

    u8g2.setFont(u8g2_font_logisoso28_tn);
    uint8_t tw = u8g2.getStrWidth(buf);
    u8g2.drawStr((128 - tw) / 2, 48, buf);

    u8g2.setFont(u8g2_font_6x13_tr);
    const char *hint = started ? "TAP to cancel" : "TAP to start";
    u8g2.drawStr((128 - u8g2.getStrWidth(hint)) / 2, 62, hint);

    rotateBuffer180();
    u8g2.sendBuffer();
}

TimerAction timerUiOnGestureSet(TimerGestureType g) {
    if (g == TimerGestureType::SingleTap) {
        switch (_field) {
            case 0: _hours   = (_hours   + 1) % 24; break;
            case 1: _minutes = (_minutes + 1) % 60; break;
            case 2: _seconds = (_seconds + 1) % 60; break;
        }
        return TimerAction::Redraw;
    }
    if (g == TimerGestureType::LongPress) {
        if (_field < 2) {
            _field++;
            return TimerAction::Redraw;
        }
        uint32_t total = (uint32_t)_hours * 3600 + (uint32_t)_minutes * 60 + (uint32_t)_seconds;
        if (total == 0)
            return TimerAction::Back;
        _remainSec = total;
        _lastDisplaySec = UINT32_MAX;
        _done = false;
        _started = false;
        return TimerAction::Start;
    }
    if (g == TimerGestureType::DoubleTap)
        return TimerAction::Back;
    return TimerAction::None;
}

TimerAction timerUiOnGestureRunning(TimerGestureType g, bool done, bool started) {
    if (done) {
        if (g == TimerGestureType::SingleTap)
            return TimerAction::Dismiss;
        return TimerAction::None;
    }
    if (!started) {
        if (g == TimerGestureType::SingleTap)
            return TimerAction::Redraw;  // caller will set started and redraw
        if (g == TimerGestureType::LongPress)
            return TimerAction::GoToSet;
        return TimerAction::None;
    }
    if (g == TimerGestureType::SingleTap || g == TimerGestureType::DoubleTap || g == TimerGestureType::LongPress)
        return TimerAction::Dismiss;
    return TimerAction::None;
}

bool timerUiTick(unsigned long nowMs) {
    if (!_started || _done) return false;
    if (nowMs - _lastTickMs < 1000) return false;
    unsigned long ticks = (nowMs - _lastTickMs) / 1000;
    if (ticks > _remainSec) ticks = _remainSec;
    _remainSec -= (uint32_t)ticks;
    _lastTickMs += ticks * 1000;
    if (_remainSec == 0) {
        _done = true;
        _lastDisplaySec = 0;
        return true;
    }
    if (_remainSec != _lastDisplaySec) {
        _lastDisplaySec = _remainSec;
        return true;
    }
    return false;
}

uint8_t  timerUiGetHours()     { return _hours; }
uint8_t  timerUiGetMinutes()   { return _minutes; }
uint8_t  timerUiGetSeconds()   { return _seconds; }
uint8_t  timerUiGetField()     { return _field; }
uint32_t timerUiGetRemainSec() { return _remainSec; }
bool     timerUiGetStarted()   { return _started; }
bool     timerUiGetDone()      { return _done; }

void timerUiSetStarted(bool started) { _started = started; }
void timerUiSetLastTickMs(unsigned long ms) { _lastTickMs = ms; }
