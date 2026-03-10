// ==========================================================================
//  QBIT -- Display task (state machine) implementation
// ==========================================================================
#include "display_task.h"
#include "app_state.h"
#include "settings.h"
#include "display_helpers.h"
#include "qr_code.h"
#include "time_manager.h"
#include "poke_handler.h"
#include "network_task.h"
#include "mqtt_ha.h"
#include "melodies.h"
#include "gif_player.h"
#include "timer_ui.h"
#include "games/game_menu.h"
#include "games/trex_runner/trex_runner.h"
#include "games/flappy_bird/flappy_bird.h"
#include "games/car_avoidance/car_avoidance.h"

#include "gif_types.h"
#include "sys_scx.h"
#include "sys_idle.h"

#include <NonBlockingRtttl.h>
#include <WiFi.h>
#include <stdio.h>

// ==========================================================================
//  Configuration
// ==========================================================================

#define BOOT_GIF_SPEED       10
#define CONNECTED_INFO_MS    3000
#define CLAIM_TIMEOUT_MS     30000
#define CLAIM_LONG_PRESS_MS  2000
#define HISTORY_IDLE_MS      3000
#define SETTINGS_MENU_IDLE_MS 10000
#define OFFLINE_OVERLAY_MS   2000
#define UPDATE_PROMPT_MS     8000
// Must match network_task WIFI_RECONNECT_TIMEOUT_MS (AP portal starts after this)
#define WIFI_AP_TIMEOUT_MS   15000
#define WIFI_AP_PROGRESS_LEN 18

// ==========================================================================
//  Internal state
// ==========================================================================

static DisplayState _state = BOOT_ANIM;
static DisplayState _prevState = GIF_PLAYBACK;
static unsigned long _stateEntryMs = 0;

// Boot animation
static uint8_t _bootFrame = 0;

// History browsing
static uint8_t _historyIndex = 0;
static int16_t _historyScrollOffset = 0;
static unsigned long _historyLastScrollMs = 0;
// Text-only history: separate scroll like bitmap
static uint16_t _historyTextSenderWidth = 0;
static uint16_t _historyTextMessageWidth = 0;
static int16_t _historyTextSenderScrollOffset = 0;
static int16_t _historyTextMessageScrollOffset = 0;

// Offline overlay
static bool          _offlineShown = false;
static unsigned long _offlineStartMs = 0;
static const char*   _offlineMsg = nullptr;
static bool          _serverOfflineNotified = false;

// WiFi setup: QR vs text toggle; only show QR when AP portal is active
static bool _wifiSetupShowQR = true;
static bool _wifiSetupPortalDrawn = false;
// Throttle redraw for connecting progress (only when bar or seconds change)
static uint8_t _lastWifiConnBar = 0xFF;
static uint8_t _lastWifiConnSec = 0xFF;

// Melody tracking
static bool _melodyWasPlaying = false;
// Timer alarm: play even when muted; restore mute when melody ends
static bool _timerAlarmRestoreMute = false;
static bool _timerAlarmStarted    = false;

// Settings menu
static uint8_t _settingsCursor    = 0;
static bool    _settingsConfirming = false;
static bool    _settingsSelected   = false;  // row is "entered" via hold

struct SettingsPending {
    bool gifSound;
    bool negativeGif;
    bool flipMode;
    bool timeFormat24h;
};
static SettingsPending _settingsPending;

// Helper: whether current display state is any in-game view
static bool isGameDisplayState(DisplayState s) {
    return s == TREX_RUNNING || s == TREX_OVER ||
           s == FLAPPY_RUNNING || s == FLAPPY_OVER ||
           s == CAR_RUNNING || s == CAR_OVER;
}

// ==========================================================================
//  State transition helper
// ==========================================================================

static void enterState(DisplayState newState) {
    if (_state == TIMER_RUNNING && newState != TIMER_RUNNING) {
        _timerAlarmStarted = false;
        if (_timerAlarmRestoreMute) {
            setBuzzerVolume(0);
            _timerAlarmRestoreMute = false;
        }
    }
    _prevState = _state;
    _state = newState;
    _stateEntryMs = millis();
}

// ==========================================================================
//  Settings menu: 16x16 icons for top-level (Timer, Game playground, Setting)
//  Icon bitmaps: XBM-style, 16x16, 32 bytes each (2 bytes/row).
// ==========================================================================
#define SETTINGS_ICON_W  16
#define SETTINGS_ICON_H  16
#define SETTINGS_ICON_GAP 6
#define SETTINGS_TEXT_X  (6 + SETTINGS_ICON_W + SETTINGS_ICON_GAP)
#define SETTINGS_ROW_H   20   /* row baseline spacing; box height = 18 for icon + padding */
#define SETTINGS_BOX_X   2
#define SETTINGS_BOX_W   124
#define SETTINGS_BOX_R   4    /* radius for rounded cap; drawn on buffer left so it shows on display left (icon side) */

static const uint8_t icon_timer_bits[] PROGMEM = {
    0x9E, 0x3C, 0xCD, 0x59, 0xB7, 0x76, 0x0B, 0x68,
    0x05, 0x50, 0x82, 0x20, 0x82, 0x20, 0x81, 0x40,
    0x83, 0x60, 0x41, 0x40, 0x22, 0x20, 0x12, 0x20,
    0x04, 0x10, 0x08, 0x08, 0xB4, 0x16, 0xC2, 0x21
};
static const uint8_t icon_game_bits[] PROGMEM = {
    0x00, 0x00, 0xFF, 0xFF, 0x01, 0x80, 0xFD, 0xBF,
    0x05, 0xA0, 0x05, 0xA0, 0x05, 0xA0, 0x05, 0xA0,
    0x05, 0xA0, 0xFD, 0xBF, 0x01, 0x80, 0xFF, 0xFF,
    0xC0, 0x03, 0xC0, 0x03, 0xF0, 0x0F, 0x00, 0x00
};
static const uint8_t icon_setting_bits[] PROGMEM = {
    0xC0, 0x03, 0x48, 0x12, 0x34, 0x2C, 0x02, 0x40,
    0xC4, 0x23, 0x24, 0x24, 0x13, 0xC8, 0x11, 0x88,
    0x11, 0x88, 0x13, 0xC8, 0x24, 0x24, 0xC4, 0x23,
    0x02, 0x40, 0x34, 0x2C, 0x48, 0x12, 0xC0, 0x03
};

static void drawSettingsMenu() {
    if (_state == SETTINGS_MENU) {
        static const char *labels[3] = { "TIMER", "GAME LIBRARY", "SETTING" };
        static const uint8_t *icon_bits[3] = {
            icon_timer_bits,
            icon_game_bits,
            icon_setting_bits
        };
        u8g2.clearBuffer();
        u8g2.setFont(u8g2_font_7x14B_tr);
        for (uint8_t row = 0; row < 3; row++) {
            uint8_t y = (row + 1) * SETTINGS_ROW_H;
            bool isSelected = (row == _settingsCursor);
            if (isSelected) {
                u8g2.setDrawColor(1);
                // Rounded on display left (icon side): draw rounded cap on buffer left, main box to its right.
                uint8_t capW = (uint8_t)(SETTINGS_BOX_R * 2);
                u8g2.drawBox(SETTINGS_BOX_X + capW, y - 14, (uint8_t)(SETTINGS_BOX_W - capW), 18);
                u8g2.drawRBox(SETTINGS_BOX_X, y - 14, capW, 18, SETTINGS_BOX_R);
                u8g2.drawBox(SETTINGS_BOX_X + SETTINGS_BOX_R, y - 14, (uint8_t)SETTINGS_BOX_R, 18);
                u8g2.setDrawColor(0);
            } else {
                u8g2.setDrawColor(1);
            }
            u8g2.setBitmapMode(1);
            u8g2.drawXBM(6, y - 13, SETTINGS_ICON_W, SETTINGS_ICON_H, icon_bits[row]);
            u8g2.setBitmapMode(0);
            u8g2.setDrawColor(isSelected ? 0 : 1);
            u8g2.drawStr(SETTINGS_TEXT_X, y, labels[row]);
        }
        u8g2.setDrawColor(1);
        rotateBuffer180();
        u8g2.sendBuffer();
        return;
    }

    // SETTINGS_OPTIONS: 5 items (QBIT Sound, GIF Invert, Flip Mode, Clock Format, [ SAVE ]). DBL = back.
    static const char *labels[5] = {
        "QBIT Sound", "GIF Invert", "Flip Mode", "Clock Format",
        "[ SAVE ]"
    };
    bool vals[5] = {
        _settingsPending.gifSound,
        _settingsPending.negativeGif,
        _settingsPending.flipMode,
        _settingsPending.timeFormat24h,
        false
    };

    uint8_t top = 0;
    if (_settingsCursor >= 4) top = _settingsCursor - 3;

    u8g2.clearBuffer();
    u8g2.setFont(u8g2_font_6x13_tr);

    for (uint8_t row = 0; row < 4; row++) {
        uint8_t item = top + row;
        if (item >= 5) break;

        uint8_t y = (row + 1) * 15;
        bool isSelected = (item == _settingsCursor);
        bool isActionRow = (item >= 4);

        if (isSelected) {
            u8g2.setDrawColor(1);
            u8g2.drawBox(0, y - 12, 128, 14);
            u8g2.setDrawColor(0);
        } else {
            u8g2.setDrawColor(1);
        }

        if (isActionRow) {
            uint8_t w = u8g2.getStrWidth(labels[item]);
            u8g2.drawStr((128 - (int16_t)w) / 2, y, labels[item]);
        } else {
            const char *val;
            uint8_t badgeW = 20;
            int16_t badgeX;
            if (item == 3) {
                val     = vals[item] ? "24h" : "12h";
                badgeW  = 24;
                badgeX  = (int16_t)128 - (int16_t)badgeW - 2 + 4;
            } else {
                val    = vals[item] ? "ON " : "OFF";
                badgeX = (int16_t)128 - (int16_t)badgeW - 2;
            }
            badgeX -= 6;
            bool entered = isSelected && _settingsSelected;

            char labelBuf[20];
            snprintf(labelBuf, sizeof(labelBuf), "%-13s", labels[item]);
            u8g2.drawStr(6, y, labelBuf);

            uint8_t boxW = (uint8_t)((int16_t)128 - badgeX + 1);
            if (boxW > badgeW + 2) boxW = badgeW + 2;
            if (entered) {
                u8g2.setDrawColor(0);
                u8g2.drawBox((int16_t)badgeX - 1, y - 12, boxW, 14);
                u8g2.setDrawColor(1);
                u8g2.drawStr((uint8_t)badgeX, y, val);
                u8g2.setDrawColor(0);
            } else {
                u8g2.drawStr((uint8_t)badgeX, y, val);
            }
        }
    }

    u8g2.setDrawColor(1);
    rotateBuffer180();
    u8g2.sendBuffer();
}

static void enterSettingsMenu() {
    _settingsCursor     = 0;
    _settingsConfirming = false;
    _settingsSelected   = false;
    _settingsPending    = { getBuzzerVolume() > 0,
                            getNegativeGif(),
                            getFlipMode(),
                            getTimeFormat24h() };
    enterState(SETTINGS_MENU);
    drawSettingsMenu();
}

static void drawContributeScreen() {
    u8g2.clearBuffer();
    u8g2.setFont(u8g2_font_6x13_tr);
    const char *title = "[ More games ]";
    const char *line2 = "Contribute your";
    const char *line3 = "game on GitHub!";
    u8g2.drawStr((128 - (int16_t)u8g2.getStrWidth(title)) / 2, 13, title);
    u8g2.drawStr((128 - (int16_t)u8g2.getStrWidth(line2)) / 2, 43, line2);
    u8g2.drawStr((128 - (int16_t)u8g2.getStrWidth(line3)) / 2, 58, line3);
    rotateBuffer180();
    u8g2.sendBuffer();
}

// Terminal-style countdown: title, blank line, "AP in Xs", progress bar. Countdown starts when network declares connection lost.
// Bar style: [#] filled, [.] empty (e.g. [##########........])
static void showWifiConnectingProgress(unsigned long nowMs) {
    unsigned long wifiLostMs = networkGetWifiLostMs();
    char line3[20];
    char bar[WIFI_AP_PROGRESS_LEN + 4];

    if (wifiLostMs == 0) {
        snprintf(line3, sizeof(line3), " Connecting");
        bar[0] = '[';
        for (unsigned int i = 0; i < WIFI_AP_PROGRESS_LEN; i++) bar[i + 1] = '.';
        bar[WIFI_AP_PROGRESS_LEN + 1] = ']';
        bar[WIFI_AP_PROGRESS_LEN + 2] = '\0';
    } else {
        unsigned long elapsed = nowMs - wifiLostMs;
        unsigned long remainingMs = (elapsed >= WIFI_AP_TIMEOUT_MS) ? 0 : (WIFI_AP_TIMEOUT_MS - elapsed);
        unsigned int remainingSec = (unsigned int)((remainingMs + 500) / 1000);
        unsigned int filled = (unsigned int)((elapsed * (WIFI_AP_PROGRESS_LEN + 1)) / WIFI_AP_TIMEOUT_MS);
        if (filled > WIFI_AP_PROGRESS_LEN) filled = WIFI_AP_PROGRESS_LEN;

        snprintf(line3, sizeof(line3), " AP in %us", (unsigned)remainingSec);
        bar[0] = '[';
        for (unsigned int i = 0; i < WIFI_AP_PROGRESS_LEN; i++)
            bar[i + 1] = (i < filled) ? '#' : '.';
        bar[WIFI_AP_PROGRESS_LEN + 1] = ']';
        bar[WIFI_AP_PROGRESS_LEN + 2] = '\0';
    }
    showText("[ Wi-Fi Setup ]", "", line3, bar);
}

// ==========================================================================
//  Show poke history entry (bitmap or text fallback)
// ==========================================================================

static void showPokeHistoryEntry(uint8_t index) {
    PokeRecord *rec = pokeGetHistory(index);
    if (!rec) {
        showText("[ No Pokes ]", "", "No history yet.", "");
        return;
    }


    // Format header: [ MM/DD HH:MM ]
    char timeBuf[32];
    struct tm ti;
    localtime_r(&rec->timestamp, &ti);
    if (getTimeFormat24h()) {
        strftime(timeBuf, sizeof(timeBuf), "[ %m/%d %H:%M ]", &ti);
    } else {
        strftime(timeBuf, sizeof(timeBuf), "[ %m/%d %I:%M %p ]", &ti);
    }

    _historyScrollOffset = 0;
    _historyLastScrollMs = millis();

    if (rec->hasBitmaps) {
        _historyScrollOffset = 0;
        showPokeHistoryBitmap(rec, timeBuf, 0);
    } else {
        pokeGetHistoryTextWidths(rec, &_historyTextSenderWidth, &_historyTextMessageWidth);
        _historyTextSenderScrollOffset = 0;
        _historyTextMessageScrollOffset = 0;
        showPokeHistoryText(rec, timeBuf, 0, 0);
    }
}

// ==========================================================================
//  Boot animation (blocking during frame render)
// ==========================================================================

static void playBootAnimation() {
    uint8_t frameBuf[QGIF_FRAME_SIZE];

    if (getBuzzerVolume() > 0) {
        rtttl::begin(getPinBuzzer(), BOOT_MELODY);
    }

    for (uint8_t f = 0; f < sys_scx_gif.frame_count; f++) {
        if (getBuzzerVolume() > 0 && rtttl::isPlaying()) {
            rtttl::play();
        }

        memcpy_P(frameBuf, sys_scx_gif.frames[f], QGIF_FRAME_SIZE);
        gifRenderFrame(&u8g2, frameBuf, sys_scx_gif.width, sys_scx_gif.height);

        uint16_t d = sys_scx_gif.delays[f] / BOOT_GIF_SPEED;
        vTaskDelay(pdMS_TO_TICKS(d > 0 ? d : 1));
    }

    rtttl::stop();
    noTone(getPinBuzzer());
}

// ==========================================================================
//  Display task main loop
// ==========================================================================

void displayTask(void *param) {
    (void)param;

    pokeHandlerInit();

    // --- BOOT_ANIM state ---
    playBootAnimation();

    // Check WiFi status after boot animation
    EventBits_t bits = xEventGroupGetBits(connectivityBits);
    if (bits & WIFI_CONNECTED_BIT) {
        enterState(CONNECTED_INFO);
        String ip = WiFi.localIP().toString();
        showText("[ Wi-Fi Connected ]",
                 "",
                 ip.c_str(),
                 "http://qbit.local");
    } else {
        enterState(WIFI_SETUP);
        _wifiSetupShowQR = true;
        _wifiSetupPortalDrawn = false;
        if (bits & PORTAL_ACTIVE_BIT) {
            _wifiSetupPortalDrawn = true;
            String apPwd = getApPassword();
            showWifiQR("QBIT", apPwd.c_str());
        } else {
            _lastWifiConnBar = 0xFF;
            _lastWifiConnSec = 0xFF;
            showWifiConnectingProgress(millis());
        }
    }

    // Main state machine loop
    for (;;) {
        unsigned long now = millis();
        unsigned long elapsed = now - _stateEntryMs;

        // --- Advance melody ---
        if (rtttl::isPlaying()) {
            rtttl::play();
            _melodyWasPlaying = true;
        } else if (_melodyWasPlaying) {
            noTone(getPinBuzzer());
            _melodyWasPlaying = false;
        }

        // --- Check for network events ---
        NetworkEvent netEvt;
        if (xQueueReceive(networkEventQueue, &netEvt, 0) == pdTRUE) {
            switch (netEvt.kind) {
                case NetworkEvent::POKE:
                    if (_state != CLAIM_PROMPT && _state != FRIEND_PROMPT) {
                        // Avoid overwriting custom poke text with generic "Poke!" (e.g. from HA button when text entity was used)
                        const char *cur = pokeGetCurrentMessage();
                        if (cur && _state == POKE_DISPLAY && strcmp(netEvt.text, "Poke!") == 0 && strcmp(cur, "Poke!") != 0) {
                            break;
                        }
                        handlePoke(netEvt.sender, netEvt.text, netEvt.title[0] ? netEvt.title : nullptr);
                        if (getBuzzerVolume() > 0) {
                            noTone(getPinBuzzer());
                            rtttl::begin(getPinBuzzer(), POKE_MELODY);
                        }
                        enterState(POKE_DISPLAY);
                    }
                    break;

                case NetworkEvent::POKE_BITMAP:
                    if (_state != CLAIM_PROMPT && _state != FRIEND_PROMPT) {
                        const char *tit = netEvt.title[0] ? netEvt.title : nullptr;
                        handlePokeBitmapFromPtrs(
                            netEvt.sender, netEvt.text,
                            netEvt.senderBmp, netEvt.senderBmpWidth, netEvt.senderBmpLen,
                            netEvt.textBmp, netEvt.textBmpWidth, netEvt.textBmpLen,
                            tit);
                        netEvt.senderBmp = nullptr;
                        netEvt.textBmp   = nullptr;
                        if (getBuzzerVolume() > 0) {
                            noTone(getPinBuzzer());
                            rtttl::begin(getPinBuzzer(), POKE_MELODY);
                        }
                        enterState(POKE_DISPLAY);
                    } else {
                        if (netEvt.senderBmp) { free(netEvt.senderBmp); netEvt.senderBmp = nullptr; }
                        if (netEvt.textBmp)   { free(netEvt.textBmp);   netEvt.textBmp   = nullptr; }
                    }
                    break;

                case NetworkEvent::CLAIM_REQUEST:
                    enterState(CLAIM_PROMPT);
                    showText("[ Claim Request ]", "", netEvt.sender, "Hold to confirm");
                    if (getBuzzerVolume() > 0) {
                        noTone(getPinBuzzer());
                        rtttl::begin(getPinBuzzer(), CLAIM_MELODY);
                    }
                    break;

                case NetworkEvent::FRIEND_REQUEST:
                    enterState(FRIEND_PROMPT);
                    showText("[ Friend Request ]", "", netEvt.sender, "Hold to confirm");
                    if (getBuzzerVolume() > 0) {
                        noTone(getPinBuzzer());
                        rtttl::begin(getPinBuzzer(), CLAIM_MELODY);
                    }
                    break;

                case NetworkEvent::WIFI_STATUS:
                    if (netEvt.connected) {
                        if (_state == WIFI_SETUP) {
                            enterState(CONNECTED_INFO);
                            String ip = WiFi.localIP().toString();
                            showText("[ Wi-Fi Connected ]",
                                     "",
                                     ip.c_str(),
                                     "http://qbit.local");
                        }
                    } else {
                        if (_state == GIF_PLAYBACK && !_offlineShown) {
                            _offlineShown = true;
                            _offlineStartMs = now;
                            _offlineMsg = "WiFi Offline";
                            showText(_offlineMsg);
                        }
                    }
                    break;

                case NetworkEvent::WS_STATUS:
                    if (!netEvt.connected && _state == GIF_PLAYBACK && !_serverOfflineNotified) {
                        _serverOfflineNotified = true;
                        _offlineShown = true;
                        _offlineStartMs = now;
                        _offlineMsg = "Server Offline";
                        showText(_offlineMsg);
                    } else if (netEvt.connected) {
                        _serverOfflineNotified = false;
                    }
                    break;

                case NetworkEvent::MQTT_COMMAND:
                    // Handle MQTT commands
                    if (strcmp(netEvt.sender, "mute") == 0) {
                        bool mute = (strcmp(netEvt.text, "ON") == 0);
                        if (mute) {
                            if (getBuzzerVolume() > 0) {
                                setSavedVolume(getBuzzerVolume());
                            }
                            setBuzzerVolume(0);
                        } else {
                            uint8_t saved = getSavedVolume();
                            setBuzzerVolume(saved > 0 ? saved : 100);
                        }
                        mqttPublishMuteState(mute);
                    } else if (strcmp(netEvt.sender, "animation_next") == 0) {
                        String next = gifPlayerNextShuffle();
                        if (next.length() > 0) {
                            gifPlayerSetFile(next);
                            mqttPublishAnimationState(next);
                        }
                    }
                    break;
            }
        }

        // --- Check for gesture events ---
        GestureEvent gesture;
        if (xQueueReceive(gestureQueue, &gesture, 0) == pdTRUE) {
            // Publish to MQTT only when not in game; never publish touch_down/touch_up (low-level press/release)
            if (!isGameDisplayState(_state) &&
                gesture.type != TOUCH_DOWN && gesture.type != TOUCH_UP)
                mqttPublishTouchEvent(gesture.type);

            switch (_state) {
                case WIFI_SETUP:
                    if (gesture.type == SINGLE_TAP && (xEventGroupGetBits(connectivityBits) & PORTAL_ACTIVE_BIT)) {
                        _wifiSetupShowQR = !_wifiSetupShowQR;
                        if (_wifiSetupShowQR) {
                            String apPwd = getApPassword();
                            showWifiQR("QBIT", apPwd.c_str());
                        } else {
                            String apPwd = getApPassword();
                            showText("[ Wi-Fi Setup ]",
                                     "SSID: QBIT",
                                     ("Pass: " + apPwd).c_str(),
                                     "Tap for QR code");
                        }
                    }
                    break;

                case GIF_PLAYBACK:
                    switch (gesture.type) {
                        case TOUCH_DOWN:
                            // Immediate audio feedback on touch
                            if (getBuzzerVolume() > 0) {
                                noTone(getPinBuzzer());
                                rtttl::begin(getPinBuzzer(), TOUCH_MELODY);
                            }
                            break;
                        case SINGLE_TAP: {
                            String next = gifPlayerNextShuffle();
                            if (next.length() > 0) {
                                gifPlayerSetFile(next);
                                mqttPublishAnimationState(next);
                            }
                            break;
                        }
                        case DOUBLE_TAP:
                            enterState(HISTORY_TIME);
                            {
                                String timeStr = timeManagerGetFormatted();
                                String dateStr = timeManagerGetDateFormatted();
                                u8g2.clearBuffer();
                                String timePart = timeStr;
                                String ampmPart;
                                if (!getTimeFormat24h()) {
                                    int sp = timeStr.indexOf(" AM");
                                    if (sp < 0) sp = timeStr.indexOf(" PM");
                                    if (sp < 0) { sp = timeStr.indexOf("AM"); if (sp < 0) sp = timeStr.indexOf("PM"); }
                                    if (sp >= 0) {
                                        timePart = timeStr.substring(0, sp);
                                        ampmPart = timeStr.substring(sp);
                                    }
                                }
                                u8g2.setFont(u8g2_font_logisoso28_tn);
                                int16_t tw = (int16_t)u8g2.getStrWidth(timePart.c_str());
                                int16_t tx = (128 - tw) / 2;
                                if (tx < 0) tx = 0;
                                u8g2.drawStr((uint8_t)tx, 38, timePart.c_str());
                                u8g2.setFont(u8g2_font_6x13_tr);
                                uint8_t dw = u8g2.getStrWidth(dateStr.c_str());
                                if (ampmPart.length() > 0) {
                                    uint8_t aw = u8g2.getStrWidth(ampmPart.c_str());
                                    int16_t line2W = (int16_t)dw + 4 + (int16_t)aw;
                                    int16_t line2X = (128 - line2W) / 2;
                                    if (line2X < 0) line2X = 0;
                                    u8g2.drawStr((uint8_t)line2X, 58, dateStr.c_str());
                                    u8g2.drawStr((uint8_t)(line2X + dw + 4), 58, ampmPart.c_str());
                                } else {
                                    u8g2.drawStr((128 - dw) / 2, 58, dateStr.c_str());
                                }
                                rotateBuffer180();
                                u8g2.sendBuffer();
                            }
                            break;
                        case LONG_PRESS:
                            enterSettingsMenu();
                            break;
                        default:
                            break;
                    }
                    break;

                case POKE_DISPLAY:
                    if (gesture.type == SINGLE_TAP) {
                        pokeSetActive(false);
                        freePokeBitmaps();
                        enterState(GIF_PLAYBACK);
                    }
                    break;

                case CLAIM_PROMPT:
                    if (gesture.type == LONG_PRESS) {
                        networkSendClaimConfirm();
                        showText("[ Claimed! ]", "", "Device bound.", "");
                        vTaskDelay(pdMS_TO_TICKS(2000));
                        enterState(GIF_PLAYBACK);
                    }
                    break;

                case FRIEND_PROMPT:
                    if (gesture.type == LONG_PRESS) {
                        networkSendFriendConfirm();
                        showText("[ Friend added! ]", "", "You're friends now.", "");
                        vTaskDelay(pdMS_TO_TICKS(2000));
                        enterState(GIF_PLAYBACK);
                    }
                    break;

                case HISTORY_TIME:
                    _stateEntryMs = now;  // reset idle timer
                    if (gesture.type == SINGLE_TAP) {
                        _historyIndex = 0;
                        enterState(HISTORY_POKE);
                        showPokeHistoryEntry(0);
                    } else if (gesture.type == DOUBLE_TAP) {
                        enterState(GIF_PLAYBACK);
                    } else if (gesture.type == LONG_PRESS) {
                        enterSettingsMenu();
                    }
                    break;

                case HISTORY_POKE:
                    _stateEntryMs = now;  // reset idle timer
                    if (gesture.type == SINGLE_TAP) {
                        _historyIndex++;
                        if (_historyIndex >= pokeHistoryCount() || _historyIndex >= 3) {
                            enterState(GIF_PLAYBACK);
                        } else {
                            showPokeHistoryEntry(_historyIndex);
                        }
                    } else if (gesture.type == DOUBLE_TAP) {
                        enterState(GIF_PLAYBACK);
                    } else if (gesture.type == LONG_PRESS) {
                        enterSettingsMenu();
                    }
                    break;

                case SETTINGS_MENU:
                    _stateEntryMs = now;
                    if (gesture.type == SINGLE_TAP) {
                        _settingsCursor = (_settingsCursor + 1) % 3;
                        drawSettingsMenu();
                    } else if (gesture.type == DOUBLE_TAP) {
                        enterState(GIF_PLAYBACK);
                    } else if (gesture.type == LONG_PRESS) {
                        if (_settingsCursor == 0) {
                            timerUiEnterSet();
                            enterState(TIMER_SET);
                            timerUiDrawSet();
                        } else if (_settingsCursor == 1) {
                            gameMenuEnter();
                            enterState(GAME_MENU);
                            gameMenuDraw();
                        } else {
                            _settingsCursor = 0;
                            enterState(SETTINGS_OPTIONS);
                            drawSettingsMenu();
                        }
                    }
                    break;

                case SETTINGS_OPTIONS:
                    _stateEntryMs = now;
                    if (_settingsConfirming) {
                        if (gesture.type == SINGLE_TAP) {
                            if (_settingsPending.gifSound) {
                                uint8_t saved = getSavedVolume();
                                setBuzzerVolume(saved > 0 ? saved : 100);
                            } else {
                                if (getBuzzerVolume() > 0) setSavedVolume(getBuzzerVolume());
                                setBuzzerVolume(0);
                            }
                            setNegativeGif(_settingsPending.negativeGif);
                            setFlipMode(_settingsPending.flipMode);
                            setTimeFormat24h(_settingsPending.timeFormat24h);
                            saveSettings();
                            mqttPublishMuteState(getBuzzerVolume() == 0);
                            showText("[ Saved! ]", "", "Settings saved.", "");
                            vTaskDelay(pdMS_TO_TICKS(1500));
                            enterState(GIF_PLAYBACK);
                        } else if (gesture.type == LONG_PRESS || gesture.type == DOUBLE_TAP) {
                            _settingsConfirming = false;
                            drawSettingsMenu();
                        }
                    } else if (_settingsSelected) {
                        if (gesture.type == SINGLE_TAP) {
                            switch (_settingsCursor) {
                                case 0: _settingsPending.gifSound      = !_settingsPending.gifSound;      break;
                                case 1: _settingsPending.negativeGif   = !_settingsPending.negativeGif;   break;
                                case 2: _settingsPending.flipMode      = !_settingsPending.flipMode;      break;
                                case 3: _settingsPending.timeFormat24h = !_settingsPending.timeFormat24h; break;
                            }
                            drawSettingsMenu();
                        } else if (gesture.type == LONG_PRESS || gesture.type == DOUBLE_TAP) {
                            _settingsSelected = false;
                            drawSettingsMenu();
                        }
                    } else {
                        if (gesture.type == SINGLE_TAP) {
                            _settingsCursor = (_settingsCursor + 1) % 5;
                            drawSettingsMenu();
                        } else if (gesture.type == DOUBLE_TAP) {
                            _settingsCursor = 0;
                            enterState(SETTINGS_MENU);
                            drawSettingsMenu();
                        } else if (gesture.type == LONG_PRESS) {
                            if (_settingsCursor == 4) {
                                _settingsConfirming = true;
                                showText("[ Save Settings? ]",
                                         "",
                                         "TAP  = confirm",
                                         "HOLD = cancel");
                            } else {
                                _settingsSelected = true;
                                drawSettingsMenu();
                            }
                        }
                    }
                    break;

                case GAME_MENU:
                    _stateEntryMs = now;
                    {
                        GameMenuGestureType mg = GameMenuGestureType::None;
                        if (gesture.type == SINGLE_TAP) mg = GameMenuGestureType::SingleTap;
                        else if (gesture.type == LONG_PRESS) mg = GameMenuGestureType::LongPress;
                        else if (gesture.type == DOUBLE_TAP) mg = GameMenuGestureType::DoubleTap;
                        GameMenuAction ma = gameMenuOnGesture(mg);
                        if (ma == GameMenuAction::Scroll) gameMenuDraw();
                        else if (ma == GameMenuAction::Launch0) {
                            updateAvailable = false;
                            trexRunnerEnter();
                            enterState(TREX_RUNNING);
                            trexRunnerDrawFrame();
                        } else if (ma == GameMenuAction::Launch1) {
                            updateAvailable = false;
                            flappyEnter();
                            enterState(FLAPPY_RUNNING);
                            flappyDrawFrame();
                        } else if (ma == GameMenuAction::Launch2) {
                            updateAvailable = false;
                            carAvoidanceEnter();
                            if (getBuzzerVolume() > 0) {
                                noTone(getPinBuzzer());
                                rtttl::begin(getPinBuzzer(), CAR_START_MELODY);
                            }
                            enterState(CAR_RUNNING);
                            carAvoidanceDrawFrame();
                        } else if (ma == GameMenuAction::OpenContribute) {
                            enterState(GAME_CONTRIBUTE);
                            drawContributeScreen();
                        } else if (ma == GameMenuAction::Back) enterSettingsMenu();
                    }
                    break;

                case GAME_CONTRIBUTE:
                    _stateEntryMs = now;
                    if (gesture.type == SINGLE_TAP || gesture.type == DOUBLE_TAP || gesture.type == LONG_PRESS) {
                        enterState(GAME_MENU);
                        gameMenuDraw();
                    }
                    break;

                default:
                    break;

                case TIMER_SET: {
                    TimerGestureType tg = TimerGestureType::None;
                    if (gesture.type == SINGLE_TAP) tg = TimerGestureType::SingleTap;
                    else if (gesture.type == LONG_PRESS) tg = TimerGestureType::LongPress;
                    else if (gesture.type == DOUBLE_TAP) tg = TimerGestureType::DoubleTap;
                    TimerAction ta = timerUiOnGestureSet(tg);
                    if (ta == TimerAction::Redraw) timerUiDrawSet();
                    else if (ta == TimerAction::Back) enterSettingsMenu();
                    else if (ta == TimerAction::Start) {
                        updateAvailable = false;
                        enterState(TIMER_RUNNING);
                        timerUiDrawRunning(timerUiGetRemainSec(), false);
                    }
                    break;
                }

                case TIMER_RUNNING: {
                    TimerGestureType tg = TimerGestureType::None;
                    if (gesture.type == SINGLE_TAP) tg = TimerGestureType::SingleTap;
                    else if (gesture.type == LONG_PRESS) tg = TimerGestureType::LongPress;
                    else if (gesture.type == DOUBLE_TAP) tg = TimerGestureType::DoubleTap;
                    TimerAction ta = timerUiOnGestureRunning(tg,
                            timerUiGetDone(), timerUiGetStarted());
                    if (ta == TimerAction::Dismiss) {
                        rtttl::stop();
                        noTone(getPinBuzzer());
                        enterState(GIF_PLAYBACK);
                    } else if (ta == TimerAction::GoToSet) {
                        timerUiEnterSet();
                        enterState(TIMER_SET);
                        timerUiDrawSet();
                    } else if (ta == TimerAction::Redraw) {
                        timerUiSetStarted(true);
                        timerUiSetLastTickMs(now);
                        timerUiDrawRunning(timerUiGetRemainSec(), true);
                    }
                    break;
                }

                case TREX_RUNNING: {
                    TrexRunnerGestureType rg = TrexRunnerGestureType::None;
                    if (gesture.type == TOUCH_DOWN) rg = TrexRunnerGestureType::TouchDown;
                    else if (gesture.type == TOUCH_UP) rg = TrexRunnerGestureType::TouchUp;
                    else if (gesture.type == SINGLE_TAP) rg = TrexRunnerGestureType::SingleTap;
                    else if (gesture.type == DOUBLE_TAP) rg = TrexRunnerGestureType::DoubleTap;
                    else if (gesture.type == LONG_PRESS) rg = TrexRunnerGestureType::LongPress;
                    TrexRunnerAction ra = trexRunnerOnGesture(rg);
                    if (ra == TrexRunnerAction::Jump) {
                        trexRunnerApplyRelease();
                        trexRunnerApplyJump();
                        if (getBuzzerVolume() > 0) {
                            noTone(getPinBuzzer());
                            rtttl::begin(getPinBuzzer(), TOUCH_MELODY);
                        }
                    } else if (ra == TrexRunnerAction::Duck) {
                        trexRunnerApplyDuck();
                    } else if (ra == TrexRunnerAction::Exit) {
                        enterState(GIF_PLAYBACK);
                    } else if (rg == TrexRunnerGestureType::TouchUp) {
                        trexRunnerApplyRelease();
                    }
                    break;
                }

                case TREX_OVER:
                    if (now - _stateEntryMs < 1500) break;
                    if (gesture.type == SINGLE_TAP) {
                        trexRunnerEnter();
                        enterState(TREX_RUNNING);
                        trexRunnerDrawFrame();
                    } else if (gesture.type == LONG_PRESS) {
                        enterState(GIF_PLAYBACK);
                    }
                    break;

                case FLAPPY_RUNNING: {
                    FlappyGestureType fg = FlappyGestureType::None;
                    if (gesture.type == TOUCH_UP)    fg = FlappyGestureType::TouchUp;
                    else if (gesture.type == TOUCH_DOWN)  fg = FlappyGestureType::TouchDown;
                    else if (gesture.type == SINGLE_TAP)  fg = FlappyGestureType::SingleTap;
                    else if (gesture.type == DOUBLE_TAP)  fg = FlappyGestureType::DoubleTap;
                    else if (gesture.type == LONG_PRESS)  fg = FlappyGestureType::LongPress;
                    FlappyAction fa = flappyOnGesture(fg);
                    if (fa == FlappyAction::Flap) {
                        flappyApplyFlap();
                        if (getBuzzerVolume() > 0) {
                            noTone(getPinBuzzer());
                            rtttl::begin(getPinBuzzer(), TOUCH_MELODY);
                        }
                    }
                    break;
                }

                case FLAPPY_OVER:
                    if (now - _stateEntryMs < 1500) break;
                    if (gesture.type == SINGLE_TAP) {
                        flappyEnter();
                        enterState(FLAPPY_RUNNING);
                        flappyDrawFrame();
                    } else if (gesture.type == LONG_PRESS) {
                        enterState(GIF_PLAYBACK);
                    }
                    break;

                case CAR_RUNNING: {
                    CarGestureType cg = CarGestureType::None;
                    if (gesture.type == TOUCH_UP)         cg = CarGestureType::TouchUp;
                    else if (gesture.type == TOUCH_DOWN)  cg = CarGestureType::TouchDown;
                    else if (gesture.type == SINGLE_TAP)  cg = CarGestureType::SingleTap;
                    else if (gesture.type == DOUBLE_TAP)  cg = CarGestureType::DoubleTap;
                    else if (gesture.type == LONG_PRESS)  cg = CarGestureType::LongPress;
                    CarAction cra = carAvoidanceOnGesture(cg);
                    if (cra == CarAction::ChangeLane) {
                        carAvoidanceApplyChangeLane();
                        if (getBuzzerVolume() > 0) {
                            noTone(getPinBuzzer());
                            rtttl::begin(getPinBuzzer(), TOUCH_MELODY);
                        }
                    } else if (cra == CarAction::Exit) {
                        enterState(GIF_PLAYBACK);
                    }
                    break;
                }

                case CAR_OVER:
                    if (now - _stateEntryMs < 1500) break;
                    if (gesture.type == SINGLE_TAP) {
                        carAvoidanceEnter();
                        if (getBuzzerVolume() > 0) {
                            noTone(getPinBuzzer());
                            rtttl::begin(getPinBuzzer(), CAR_START_MELODY);
                        }
                        enterState(CAR_RUNNING);
                        carAvoidanceDrawFrame();
                    } else if (gesture.type == LONG_PRESS) {
                        enterState(GIF_PLAYBACK);
                    }
                    break;
            }
        }

        // --- State-specific tick logic ---
        // Recalculate timing (gesture handlers may have updated _stateEntryMs)
        now = millis();
        elapsed = now - _stateEntryMs;

        switch (_state) {
            case WIFI_SETUP: {
                EventBits_t wb = xEventGroupGetBits(connectivityBits);
                if (!(wb & PORTAL_ACTIVE_BIT)) {
                    _wifiSetupPortalDrawn = false;
                    unsigned long wifiLostMs = networkGetWifiLostMs();
                    uint8_t sec = 0xFF;
                    uint8_t barFilled = 0xFF;
                    if (wifiLostMs > 0) {
                        unsigned long elapsedFromLost = now - wifiLostMs;
                        unsigned long remainingMs = (elapsedFromLost >= WIFI_AP_TIMEOUT_MS) ? 0 : (WIFI_AP_TIMEOUT_MS - elapsedFromLost);
                        sec = (uint8_t)((remainingMs + 500) / 1000);
                        barFilled = (uint8_t)((elapsedFromLost * (WIFI_AP_PROGRESS_LEN + 1)) / WIFI_AP_TIMEOUT_MS);
                        if (barFilled > WIFI_AP_PROGRESS_LEN) barFilled = WIFI_AP_PROGRESS_LEN;
                    }
                    if (sec != _lastWifiConnSec || barFilled != _lastWifiConnBar) {
                        _lastWifiConnSec = sec;
                        _lastWifiConnBar = barFilled;
                        showWifiConnectingProgress(now);
                    }
                } else if (!_wifiSetupPortalDrawn) {
                    _wifiSetupPortalDrawn = true;
                    _wifiSetupShowQR = true;
                    String apPwd = getApPassword();
                    showWifiQR("QBIT", apPwd.c_str());
                }
                if (wb & WIFI_CONNECTED_BIT) {
                    enterState(CONNECTED_INFO);
                    String ip = WiFi.localIP().toString();
                    showText("[ Wi-Fi Connected ]",
                             "",
                             ip.c_str(),
                             "http://qbit.local");
                }
                break;
            }

            case CONNECTED_INFO:
                if (elapsed >= CONNECTED_INFO_MS) {
                    enterState(GIF_PLAYBACK);
                    if (gifPlayerHasFiles()) {
                        gifPlayerBuildShuffleBag();
                        gifPlayerSetAutoAdvance(1);
                        gifPlayerSetFile(gifPlayerNextShuffle());
                    }
                }
                break;

            case GIF_PLAYBACK:
                // Handle offline overlay timeout
                if (_offlineShown && (now - _offlineStartMs >= OFFLINE_OVERLAY_MS)) {
                    _offlineShown = false;
                    _offlineMsg = nullptr;
                }

                // Update available prompt (once per boot)
                if (updateAvailable) {
                    static unsigned long updatePromptStartMs = 0;
                    if (updatePromptStartMs == 0) updatePromptStartMs = now;
                    char curLine[32], latLine[32];
                    // Add "v" only for semantic versions (e.g. 0.0.0); show dev-build etc as-is
                    auto fmtCur = (kQbitVersion[0] == 'v' || kQbitVersion[0] == 'V')
                        ? "Current: %s"
                        : (kQbitVersion[0] >= '0' && kQbitVersion[0] <= '9') ? "Current: v%s" : "Current: %s";
                    auto fmtLat = (updateAvailableVersion[0] == 'v' || updateAvailableVersion[0] == 'V')
                        ? "Latest: %s"
                        : (updateAvailableVersion[0] >= '0' && updateAvailableVersion[0] <= '9') ? "Latest: v%s" : "Latest: %s";
                    snprintf(curLine, sizeof(curLine), fmtCur, kQbitVersion);
                    snprintf(latLine, sizeof(latLine), fmtLat, updateAvailableVersion);
                    showText("[ Update available ]", "", curLine, latLine);
                    if (now - updatePromptStartMs >= UPDATE_PROMPT_MS) {
                        updateAvailable = false;
                        updatePromptStartMs = 0;
                    }
                } else if (!_offlineShown) {
                    gifPlayerTick();
                }
                break;

            case POKE_DISPLAY:
                {
                    unsigned long timeout = (pokeMaxWidth() > 128)
                        ? POKE_SCROLL_DISPLAY_MS : POKE_DISPLAY_MS;
                    if (elapsed > timeout) {
                        pokeSetActive(false);
                        freePokeBitmaps();
                        enterState(GIF_PLAYBACK);
                    } else {
                        pokeAdvanceScroll();
                    }
                }
                break;

            case CLAIM_PROMPT:
                if (elapsed > CLAIM_TIMEOUT_MS) {
                    networkSendClaimReject();
                    showText("[ Claim Timeout ]", "", "Request expired.", "");
                    vTaskDelay(pdMS_TO_TICKS(1500));
                    enterState(GIF_PLAYBACK);
                }
                break;

            case FRIEND_PROMPT:
                if (elapsed > CLAIM_TIMEOUT_MS) {
                    networkSendFriendReject();
                    showText("[ Friend Timeout ]", "", "Request expired.", "");
                    vTaskDelay(pdMS_TO_TICKS(1500));
                    enterState(GIF_PLAYBACK);
                }
                break;

            case HISTORY_TIME:
                if (elapsed >= HISTORY_IDLE_MS) {
                    enterState(GIF_PLAYBACK);
                }
                break;

            case HISTORY_POKE:
                {
                    PokeRecord *hRec = pokeGetHistory(_historyIndex);
                    bool needsScroll = false;
                    if (hRec && hRec->hasBitmaps) {
                        needsScroll = max(hRec->senderBmpW, hRec->textBmpW) > 128;
                    } else if (hRec) {
                        needsScroll = _historyTextSenderWidth > 128 || _historyTextMessageWidth > 128;
                    }
                    unsigned long timeout = needsScroll ? POKE_SCROLL_DISPLAY_MS : HISTORY_IDLE_MS;

                    if (elapsed >= timeout) {
                        enterState(GIF_PLAYBACK);
                    } else if (needsScroll) {
                        unsigned long nowMs = millis();
                        if (nowMs - _historyLastScrollMs >= POKE_SCROLL_INTERVAL_MS) {
                            _historyLastScrollMs = nowMs;
                            if (hRec->hasBitmaps) {
                                _historyScrollOffset += POKE_SCROLL_PX;
                                uint16_t maxW = max(hRec->senderBmpW, hRec->textBmpW);
                                uint16_t virtualW = maxW + 64;
                                if (_historyScrollOffset >= (int16_t)virtualW) {
                                    _historyScrollOffset -= (int16_t)virtualW;
                                }
                                char timeBuf[32];
                                struct tm ti;
                                localtime_r(&hRec->timestamp, &ti);
                                if (getTimeFormat24h()) {
                                    strftime(timeBuf, sizeof(timeBuf), "[ %m/%d %H:%M ]", &ti);
                                } else {
                                    strftime(timeBuf, sizeof(timeBuf), "[ %m/%d %I:%M %p ]", &ti);
                                }
                                showPokeHistoryBitmap(hRec, timeBuf, _historyScrollOffset);
                            } else {
                                if (_historyTextSenderWidth > 128) {
                                    _historyTextSenderScrollOffset += POKE_SCROLL_PX;
                                    uint16_t vw = _historyTextSenderWidth + 64;
                                    if (_historyTextSenderScrollOffset >= (int16_t)vw) {
                                        _historyTextSenderScrollOffset -= (int16_t)vw;
                                    }
                                }
                                if (_historyTextMessageWidth > 128) {
                                    _historyTextMessageScrollOffset += POKE_SCROLL_PX;
                                    uint16_t vw = _historyTextMessageWidth + 64;
                                    if (_historyTextMessageScrollOffset >= (int16_t)vw) {
                                        _historyTextMessageScrollOffset -= (int16_t)vw;
                                    }
                                }
                                char timeBuf[32];
                                struct tm ti;
                                localtime_r(&hRec->timestamp, &ti);
                                if (getTimeFormat24h()) {
                                    strftime(timeBuf, sizeof(timeBuf), "[ %m/%d %H:%M ]", &ti);
                                } else {
                                    strftime(timeBuf, sizeof(timeBuf), "[ %m/%d %I:%M %p ]", &ti);
                                }
                                int16_t sr = (_historyTextSenderWidth > 128) ? _historyTextSenderScrollOffset : 0;
                                int16_t mr = (_historyTextMessageWidth > 128) ? _historyTextMessageScrollOffset : 0;
                                showPokeHistoryText(hRec, timeBuf, sr, mr);
                            }
                        }
                    }
                }
                break;

            case SETTINGS_MENU:
            case SETTINGS_OPTIONS:
                if (elapsed >= SETTINGS_MENU_IDLE_MS) {
                    enterState(GIF_PLAYBACK);
                }
                break;

            case GAME_MENU:
                if (elapsed >= SETTINGS_MENU_IDLE_MS) {
                    enterState(GIF_PLAYBACK);
                }
                break;

            case GAME_CONTRIBUTE:
                if (elapsed >= SETTINGS_MENU_IDLE_MS) {
                    enterState(GAME_MENU);
                    gameMenuDraw();
                }
                break;

            case TIMER_SET:
                // Idle — redrawn only on gesture
                break;

            case TIMER_RUNNING:
                if (timerUiGetDone()) {
                    if (!rtttl::isPlaying()) {
                        if (!_timerAlarmStarted) {
                            if (getBuzzerVolume() == 0) {
                                _timerAlarmRestoreMute = true;
                                setBuzzerVolume(getSavedVolume() > 0 ? getSavedVolume() : 100);
                            }
                            noTone(getPinBuzzer());
                            rtttl::begin(getPinBuzzer(), TIMER_MELODY);
                            _timerAlarmStarted = true;
                        } else {
                            noTone(getPinBuzzer());
                            rtttl::begin(getPinBuzzer(), TIMER_MELODY);
                        }
                    }
                } else if (timerUiTick(now)) {
                    if (timerUiGetDone()) {
                        if (getBuzzerVolume() == 0) {
                            _timerAlarmRestoreMute = true;
                            setBuzzerVolume(getSavedVolume() > 0 ? getSavedVolume() : 100);
                        }
                        noTone(getPinBuzzer());
                        rtttl::begin(getPinBuzzer(), TIMER_MELODY);
                        _timerAlarmStarted = true;
                        showText("[ Timer Done! ]", "", "Time's up!", "TAP to dismiss");
                    } else {
                        timerUiDrawRunning(timerUiGetRemainSec(), true);
                    }
                }
                break;

            case TREX_RUNNING:
                trexRunnerDrawFrame(now);
                if (trexRunnerTick(now)) {
                    setTrexHighScore(trexRunnerGetScore());
                    if (getBuzzerVolume() > 0) {
                        noTone(getPinBuzzer());
                        rtttl::begin(getPinBuzzer(), MUTE_MELODY);
                    }
                    enterState(TREX_OVER);
                    trexRunnerDrawGameOver();
                }
                break;

            case TREX_OVER:
                // Idle — waiting for gesture
                break;

            case FLAPPY_RUNNING:
                flappyDrawFrame(now);
                if (flappyTick(now)) {
                    setFlappyHighScore(flappyGetScore());
                    if (getBuzzerVolume() > 0) {
                        noTone(getPinBuzzer());
                        rtttl::begin(getPinBuzzer(), MUTE_MELODY);
                    }
                    enterState(FLAPPY_OVER);
                    flappyDrawGameOver();
                }
                break;

            case FLAPPY_OVER:
                // Idle — waiting for gesture
                break;

            case CAR_RUNNING:
                carAvoidanceDrawFrame(now);
                if (carAvoidanceTick(now)) {
                    setCarHighScore(carAvoidanceGetScore());
                    if (getBuzzerVolume() > 0) {
                        noTone(getPinBuzzer());
                        rtttl::begin(getPinBuzzer(), CAR_CRASH_MELODY);
                    }
                    enterState(CAR_OVER);
                    carAvoidanceDrawGameOver();
                } else if (carAvoidanceNearMiss() && getBuzzerVolume() > 0) {
                    noTone(getPinBuzzer());
                    rtttl::begin(getPinBuzzer(), CAR_NEAR_MELODY);
                }
                break;

            case CAR_OVER:
                // Idle — waiting for gesture
                break;

            default:
                break;
        }

        // Short delay to yield CPU
        vTaskDelay(pdMS_TO_TICKS(5));
    }
}
