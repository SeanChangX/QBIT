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
#define MUTE_FEEDBACK_MS     2000
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

// ==========================================================================
//  State transition helper
// ==========================================================================

static void enterState(DisplayState newState) {
    _prevState = _state;
    _state = newState;
    _stateEntryMs = millis();
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
//  Mute toggle helper (called from any state that supports LONG_PRESS)
// ==========================================================================

static void doMuteToggle() {
    enterState(MUTE_FEEDBACK);
    bool wasMuted = (getBuzzerVolume() == 0);
    if (wasMuted) {
        uint8_t saved = getSavedVolume();
        setBuzzerVolume(saved > 0 ? saved : 100);
        showText("", "[ UNMUTED ]", "", "");
        noTone(getPinBuzzer());
        rtttl::begin(getPinBuzzer(), UNMUTE_MELODY);
    } else {
        // Play mute melody BEFORE muting
        noTone(getPinBuzzer());
        rtttl::begin(getPinBuzzer(), MUTE_MELODY);
        while (rtttl::isPlaying()) {
            rtttl::play();
            vTaskDelay(pdMS_TO_TICKS(1));
        }
        noTone(getPinBuzzer());
        setSavedVolume(getBuzzerVolume());
        setBuzzerVolume(0);
        showText("", "[ MUTED ]", "", "");
    }
    // Reset timer so feedback text shows for the full MUTE_FEEDBACK_MS
    _stateEntryMs = millis();
    mqttPublishMuteState(!wasMuted);
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

    // Format header: [ MM/DD HH:MM:SS ]
    char timeBuf[24];
    struct tm ti;
    localtime_r(&rec->timestamp, &ti);
    strftime(timeBuf, sizeof(timeBuf), "[ %m/%d %H:%M:%S ]", &ti);

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
                    if (_state != CLAIM_PROMPT && _state != MUTE_FEEDBACK) {
                        // Avoid overwriting custom poke text with generic "Poke!" (e.g. from HA button when text entity was used)
                        const char *cur = pokeGetCurrentMessage();
                        if (cur && _state == POKE_DISPLAY && strcmp(netEvt.text, "Poke!") == 0 && strcmp(cur, "Poke!") != 0) {
                            break;
                        }
                        handlePoke(netEvt.sender, netEvt.text);
                        if (getBuzzerVolume() > 0) {
                            noTone(getPinBuzzer());
                            rtttl::begin(getPinBuzzer(), POKE_MELODY);
                        }
                        enterState(POKE_DISPLAY);
                    }
                    break;

                case NetworkEvent::POKE_BITMAP:
                    if (_state != CLAIM_PROMPT && _state != MUTE_FEEDBACK) {
                        handlePokeBitmapFromPtrs(
                            netEvt.sender, netEvt.text,
                            netEvt.senderBmp, netEvt.senderBmpWidth, netEvt.senderBmpLen,
                            netEvt.textBmp, netEvt.textBmpWidth, netEvt.textBmpLen);
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
            // Only publish final gestures to MQTT (not TOUCH_DOWN)
            if (gesture.type != TOUCH_DOWN) {
                mqttPublishTouchEvent(gesture.type);
            }

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
                                u8g2.setFont(u8g2_font_logisoso28_tn);
                                uint8_t tw = u8g2.getStrWidth(timeStr.c_str());
                                u8g2.drawStr((128 - tw) / 2, 38, timeStr.c_str());
                                u8g2.setFont(u8g2_font_6x13_tr);
                                uint8_t dw = u8g2.getStrWidth(dateStr.c_str());
                                u8g2.drawStr((128 - dw) / 2, 58, dateStr.c_str());
                                rotateBuffer180();
                                u8g2.sendBuffer();
                            }
                            break;
                        case LONG_PRESS:
                            doMuteToggle();
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

                case HISTORY_TIME:
                    _stateEntryMs = now;  // reset idle timer
                    if (gesture.type == SINGLE_TAP) {
                        _historyIndex = 0;
                        enterState(HISTORY_POKE);
                        showPokeHistoryEntry(0);
                    } else if (gesture.type == DOUBLE_TAP) {
                        enterState(GIF_PLAYBACK);
                    } else if (gesture.type == LONG_PRESS) {
                        doMuteToggle();
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
                        doMuteToggle();
                    }
                    break;

                default:
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
                    snprintf(curLine, sizeof(curLine), "Current: %s", kQbitVersion);
                    snprintf(latLine, sizeof(latLine), "Latest: %s", updateAvailableVersion);
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
                                char timeBuf[24];
                                struct tm ti;
                                localtime_r(&hRec->timestamp, &ti);
                                strftime(timeBuf, sizeof(timeBuf), "[ %m/%d %H:%M:%S ]", &ti);
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
                                char timeBuf[24];
                                struct tm ti;
                                localtime_r(&hRec->timestamp, &ti);
                                strftime(timeBuf, sizeof(timeBuf), "[ %m/%d %H:%M:%S ]", &ti);
                                int16_t sr = (_historyTextSenderWidth > 128) ? _historyTextSenderScrollOffset : 0;
                                int16_t mr = (_historyTextMessageWidth > 128) ? _historyTextMessageScrollOffset : 0;
                                showPokeHistoryText(hRec, timeBuf, sr, mr);
                            }
                        }
                    }
                }
                break;

            case MUTE_FEEDBACK:
                if (elapsed >= MUTE_FEEDBACK_MS) {
                    enterState(_prevState == MUTE_FEEDBACK ? GIF_PLAYBACK : _prevState);
                }
                break;

            default:
                break;
        }

        // Short delay to yield CPU
        vTaskDelay(pdMS_TO_TICKS(5));
    }
}
