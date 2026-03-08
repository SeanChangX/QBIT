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

// Timer set / running
static uint8_t       _timerHours          = 0;
static uint8_t       _timerMinutes        = 0;
static uint8_t       _timerSeconds        = 0;
static uint8_t       _timerField          = 0;   // 0=HH, 1=MM, 2=SS
static uint32_t      _timerRemainSec      = 0;
static unsigned long _timerLastTickMs     = 0;
static uint32_t      _timerLastDisplaySec = UINT32_MAX;
static bool          _timerDone           = false;
static bool          _timerStarted        = false;

// ==========================================================================
//  Game: Endless Runner — forward declaration (enterState defined later)
// ==========================================================================
static void enterState(DisplayState newState);

// ==========================================================================
//  Game: Endless Runner
//  128x64 OLED, monochrome.
//  Ground line at y=55 (pixel row). All y values are top-left of sprite.
//
//  Character (7x10 px, pixel-art runner):
//   Frame 0  — right leg forward
//   Frame 1  — left leg forward
//
//  Obstacles:
//   Cactus-S  (7x14)  — short cactus
//   Cactus-T  (11x18) — tall cactus
//   Bird      (14x8)  — flying at y=36 (above jump reach → must duck)
//
//  Physics (integer):
//   gravity  = +3 px/tick (applied every tick when airborne)
//   jumpVel  = -14 px     (upward impulse on TAP)
//   duck     = crouch 1 frame on DOUBLE_TAP (lowers hitbox 4px)
// ==========================================================================

#define GAME_GROUND_Y   56
#define GAME_PLAYER_X   14
#define GAME_BIRD_Y     34
#define GAME_TICK_MS    33
#define GAME_SPEED_INIT 2
#define GAME_SPEEDUP_AT 300

// --- Character sprites (7 wide, 10 tall) ---
static const uint8_t GAME_CHAR_W = 7;
static const uint8_t GAME_CHAR_H = 10;
static const uint8_t GAME_RUN0[7] = {
    0b00011100,
    0b00111110,
    0b01111100,
    0b01111110,
    0b00011100,
    0b00101010,
    0b01000100
};
static const uint8_t GAME_RUN1[7] = {
    0b00011100,
    0b00111110,
    0b01111100,
    0b01111110,
    0b00011100,
    0b00111100,
    0b01100110
};
static const uint8_t GAME_CHAR_DUCK_H = 7;
static const uint8_t GAME_DUCK[7] = {
    0b0111110,
    0b1111111,
    0b1111111,
    0b0111110,
    0b0111110,
    0b0111110,
    0b0000000
};

// --- Cactus-S sprite (7x14) ---
static const uint8_t GAME_CACTUS_S_W = 7;
static const uint8_t GAME_CACTUS_S_H = 14;
static const uint8_t GAME_CACTUS_S[7] = {
    0b00000000,
    0b11000110,
    0b11111110,
    0b00111000,
    0b00111000,
    0b11111110,
    0b11000110
};

// --- Cactus-T sprite (9x18) ---
static const uint8_t GAME_CACTUS_T_W = 9;
static const uint8_t GAME_CACTUS_T_H = 18;
static const uint8_t GAME_CACTUS_T[9] = {
    0b00000000,
    0b11000110,
    0b11111110,
    0b11111110,
    0b00111000,
    0b00111000,
    0b00111000,
    0b11111110,
    0b11000110
};

// --- Bird sprite (14x8) ---
static const uint8_t GAME_BIRD_W = 14;
static const uint8_t GAME_BIRD_H = 8;
static const uint8_t GAME_BIRD0[14] = {
    0b00000000,
    0b00111111,
    0b01111111,
    0b11111111,
    0b11111111,
    0b01111111,
    0b00111111,
    0b00000000,
    0b00001110,
    0b00011110,
    0b00001110,
    0b00000000,
    0b00000000,
    0b00000000
};
static const uint8_t GAME_BIRD1[14] = {
    0b00000000,
    0b00000111,
    0b00001111,
    0b11111111,
    0b11111111,
    0b00001111,
    0b00000111,
    0b00000000,
    0b00001110,
    0b00011110,
    0b00001110,
    0b00000000,
    0b00000000,
    0b00000000
};

// Obstacle types
enum ObstacleType { OBS_NONE, OBS_CACTUS_S, OBS_CACTUS_T, OBS_BIRD };

struct Obstacle {
    ObstacleType type;
    int16_t      x;
};

// Game state
static int16_t   _gamePlayerY   = 0;
static int16_t   _gameVelY      = 0;
static bool      _gameOnGround  = true;
static bool      _gameDucking   = false;
static uint8_t   _gameCharFrame = 0;
static uint8_t   _gameBirdFrame = 0;
static uint8_t   _gameAnimTick  = 0;

static Obstacle  _gameObs[2];
static uint8_t   _gameSpeed     = GAME_SPEED_INIT;
static uint32_t  _gameScore     = 0;
static unsigned long _gameLastTickMs = 0;
static bool      _gameOver      = false;
static uint8_t   _gameScoreTick = 0;

// --- Background parallax ---
static const uint8_t GAME_STAR_COUNT = 6;
static const uint8_t GAME_STAR_Y[6]  = { 5, 12, 8, 18, 4, 15 };
static int16_t _gameStarX[6]         = { 10, 30, 52, 74, 95, 115 };
static uint8_t _gameStarTick         = 0;

struct Cloud { int16_t x; uint8_t y; };
static Cloud   _gameClouds[2]        = { {40, 20}, {100, 25} };
static uint8_t _gameCloudTick        = 0;

static uint16_t _gameRandState = 1;
static uint16_t gameRand() {
    _gameRandState ^= _gameRandState << 7;
    _gameRandState ^= _gameRandState >> 9;
    _gameRandState ^= _gameRandState << 8;
    return _gameRandState;
}

static void spawnObstacle(Obstacle &obs) {
    uint16_t r = gameRand();
    uint16_t gap = 40 + (r % 50);
    obs.x = 128 + (int16_t)gap;
    uint8_t kind = r % 3;
    if      (kind == 0) obs.type = OBS_CACTUS_S;
    else if (kind == 1) obs.type = OBS_CACTUS_T;
    else                obs.type = OBS_BIRD;
}

static void drawSprite(int16_t x, int16_t y, const uint8_t *cols, uint8_t w, uint8_t h) {
    for (uint8_t col = 0; col < w; col++) {
        uint8_t data = cols[col];
        for (uint8_t row = 0; row < h; row++) {
            if (data & (1 << row)) {
                u8g2.drawPixel(x + col, y + row);
            }
        }
    }
}

static void drawGameFrame() {
    u8g2.clearBuffer();
    u8g2.setDrawColor(1);

    // Score (top-right, small font)
    u8g2.setFont(u8g2_font_6x10_tr);
    char scoreBuf[10];
    snprintf(scoreBuf, sizeof(scoreBuf), "%05lu", (unsigned long)_gameScore);
    u8g2.drawStr(128 - u8g2.getStrWidth(scoreBuf) - 1, 10, scoreBuf);

    // Stars (slow scroll)
    for (uint8_t s = 0; s < GAME_STAR_COUNT; s++) {
        if (_gameStarX[s] >= 0 && _gameStarX[s] < 128)
            u8g2.drawPixel(_gameStarX[s], GAME_STAR_Y[s]);
    }

    // Clouds (medium scroll)
    for (uint8_t c = 0; c < 2; c++) {
        int16_t cx = _gameClouds[c].x;
        uint8_t cy = _gameClouds[c].y;
        u8g2.drawHLine(cx,     cy + 1, 8);
        u8g2.drawHLine(cx + 2, cy,     4);
    }

    // Ground line
    u8g2.drawHLine(0, GAME_GROUND_Y, 128);

    // Player
    if (_gameDucking) {
        int16_t duckY = GAME_GROUND_Y - GAME_CHAR_DUCK_H + 1;
        drawSprite(GAME_PLAYER_X, duckY, GAME_DUCK, GAME_CHAR_W, GAME_CHAR_DUCK_H);
    } else {
        const uint8_t *frame = (_gameCharFrame == 0) ? GAME_RUN0 : GAME_RUN1;
        drawSprite(GAME_PLAYER_X, _gamePlayerY, frame, GAME_CHAR_W, GAME_CHAR_H);
    }

    // Obstacles
    for (uint8_t i = 0; i < 2; i++) {
        Obstacle &obs = _gameObs[i];
        if (obs.type == OBS_NONE || obs.x > 127) continue;
        switch (obs.type) {
            case OBS_CACTUS_S:
                drawSprite(obs.x, GAME_GROUND_Y - GAME_CACTUS_S_H + 1,
                           GAME_CACTUS_S, GAME_CACTUS_S_W, GAME_CACTUS_S_H);
                break;
            case OBS_CACTUS_T:
                drawSprite(obs.x, GAME_GROUND_Y - GAME_CACTUS_T_H + 1,
                           GAME_CACTUS_T, GAME_CACTUS_T_W, GAME_CACTUS_T_H);
                break;
            case OBS_BIRD: {
                const uint8_t *bf = (_gameBirdFrame == 0) ? GAME_BIRD0 : GAME_BIRD1;
                drawSprite(obs.x, GAME_BIRD_Y, bf, GAME_BIRD_W, GAME_BIRD_H);
                break;
            }
            default: break;
        }
    }

    rotateBuffer180();
    u8g2.sendBuffer();
}

static void drawGameOver() {
    u8g2.clearBuffer();
    u8g2.setFont(u8g2_font_6x13_tr);

    const char *hdr = "[ Game Over ]";
    u8g2.drawStr((128 - u8g2.getStrWidth(hdr)) / 2, 13, hdr);

    char scoreLine[20], bestLine[20];
    snprintf(scoreLine, sizeof(scoreLine), "Score: %05lu", (unsigned long)_gameScore);
    snprintf(bestLine,  sizeof(bestLine),  "Best:  %05lu", (unsigned long)getGameHighScore());
    u8g2.drawStr((128 - u8g2.getStrWidth(scoreLine)) / 2, 32, scoreLine);
    u8g2.drawStr((128 - u8g2.getStrWidth(bestLine))  / 2, 46, bestLine);

    const char *hint = "TAP=retry  HOLD=exit";
    u8g2.drawStr((128 - u8g2.getStrWidth(hint)) / 2, 62, hint);

    rotateBuffer180();
    u8g2.sendBuffer();
}

static void enterGame() {
    _gameRandState   = (uint16_t)(millis() & 0xFFFF) | 1;
    _gamePlayerY     = GAME_GROUND_Y - GAME_CHAR_H + 1;
    _gameVelY        = 0;
    _gameOnGround    = true;
    _gameDucking     = false;
    _gameCharFrame   = 0;
    _gameBirdFrame   = 0;
    _gameAnimTick    = 0;
    _gameScore       = 0;
    _gameOver        = false;
    _gameSpeed       = GAME_SPEED_INIT;
    _gameScoreTick   = 0;
    _gameLastTickMs  = millis();

    _gameStarTick  = 0;
    _gameCloudTick = 0;
    const uint8_t starXInit[GAME_STAR_COUNT] = { 10, 30, 52, 74, 95, 115 };
    for (uint8_t s = 0; s < GAME_STAR_COUNT; s++) _gameStarX[s] = starXInit[s];
    _gameClouds[0] = { 40,  20 };
    _gameClouds[1] = { 100, 25 };

    _gameObs[0] = { OBS_CACTUS_S, 160 };
    _gameObs[1] = { OBS_NONE, 256 };

    updateAvailable = false;  // don't interrupt game with update prompt
    enterState(GAME_RUNNING);
    drawGameFrame();
}

// ==========================================================================
//  State transition helper
// ==========================================================================

static void enterState(DisplayState newState) {
    _prevState = _state;
    _state = newState;
    _stateEntryMs = millis();
}

// ==========================================================================
//  Settings menu renderer
// ==========================================================================

static void drawSettingsMenu() {
    // 8 items: Timer + Game + 4 toggles + Save + Exit
    // Show 4 rows at a time; scroll window follows cursor
    static const char *labels[8] = {
        "Timer", "Game",
        "QBIT Sound", "GIF Invert", "Flip Mode", "Clock Format",
        "[ SAVE ]", "[ EXIT ]"
    };
    bool vals[8] = {
        false, false,
        _settingsPending.gifSound,
        _settingsPending.negativeGif,
        _settingsPending.flipMode,
        _settingsPending.timeFormat24h,
        false, false
    };

    // Scroll window: keep cursor visible (4 rows visible, 8 total)
    uint8_t top = 0;
    if (_settingsCursor >= 4) top = _settingsCursor - 3;

    u8g2.clearBuffer();
    u8g2.setFont(u8g2_font_6x13_tr);

    for (uint8_t row = 0; row < 4; row++) {
        uint8_t item = top + row;
        if (item >= 8) break;

        uint8_t y = (row + 1) * 15;  // y baseline: 15, 30, 45, 60
        bool isSelected = (item == _settingsCursor);
        bool isActionRow = (item < 2 || item >= 6);

        // Cursor row: full row inverted
        if (isSelected) {
            u8g2.setDrawColor(1);
            u8g2.drawBox(0, y - 12, 128, 14);
            u8g2.setDrawColor(0);
        } else {
            u8g2.setDrawColor(1);
        }

        if (isActionRow) {
            if (item < 2) {
                char buf[20];
                snprintf(buf, sizeof(buf), "%-13s", labels[item]);
                u8g2.drawStr(6, y, buf);
            } else {
                // Save / Exit — centred
                uint8_t w = u8g2.getStrWidth(labels[item]);
                u8g2.drawStr((128 - (int16_t)w) / 2, y, labels[item]);
            }
        } else {
            const char *val;
            uint8_t badgeW = 20;
            int16_t badgeX;
            if (item == 5) {  // Clock Format
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

// ==========================================================================
//  Timer set / running renderers
// ==========================================================================

static void drawTimerSet() {
    u8g2.clearBuffer();

    u8g2.setFont(u8g2_font_6x13_tr);
    const char *hdr = "[ Set Timer ]";
    u8g2.drawStr((128 - u8g2.getStrWidth(hdr)) / 2, 12, hdr);

    u8g2.setFont(u8g2_font_logisoso28_tn);
    char buf[9];
    snprintf(buf, sizeof(buf), "%02d:%02d:%02d",
             _timerHours, _timerMinutes, _timerSeconds);

    uint8_t tw = u8g2.getStrWidth(buf);
    int16_t tx = (128 - tw) / 2;
    const int16_t ty = 48;

    char hhStr[3], mmStr[3], sepStr[2] = ":";
    snprintf(hhStr, sizeof(hhStr), "%02d", _timerHours);
    snprintf(mmStr, sizeof(mmStr), "%02d", _timerMinutes);
    uint8_t wDigits = u8g2.getStrWidth(hhStr);
    uint8_t wColon  = u8g2.getStrWidth(sepStr);

    int16_t fieldStartX[3] = {
        tx,
        (int16_t)(tx + wDigits + wColon),
        (int16_t)(tx + wDigits + wColon + (int16_t)u8g2.getStrWidth(mmStr) + wColon)
    };

    u8g2.setDrawColor(1);
    u8g2.drawStr(tx, ty, buf);

    u8g2.setDrawColor(2);
    u8g2.drawBox(fieldStartX[_timerField] - 1, ty - 28, wDigits + 2, 30);

    u8g2.setFont(u8g2_font_6x13_tr);
    u8g2.setDrawColor(1);
    const char *hint = (_timerField < 2) ? "TAP:+1  HOLD:next"
                                         : "TAP:+1  HOLD:start";
    u8g2.drawStr((128 - u8g2.getStrWidth(hint)) / 2, 62, hint);

    rotateBuffer180();
    u8g2.sendBuffer();
}

static void enterTimerSet() {
    _timerHours   = 0;
    _timerMinutes = 0;
    _timerSeconds = 0;
    _timerField   = 0;
    enterState(TIMER_SET);
    drawTimerSet();
}

static void drawTimerRunning(uint32_t remainSec, bool started) {
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
                    _stateEntryMs = now;  // reset idle timer on any input (10s auto-exit)
                    if (_settingsConfirming) {
                        if (gesture.type == SINGLE_TAP) {
                            // Confirmed — apply pending values and save
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
                        } else if (gesture.type == LONG_PRESS) {
                            // Cancel — back to menu
                            _settingsConfirming = false;
                            drawSettingsMenu();
                        }
                    } else if (_settingsSelected) {
                        // A toggle row is entered — TAP toggles, HOLD exits row
                        if (gesture.type == SINGLE_TAP) {
                            switch (_settingsCursor) {
                                case 2: _settingsPending.gifSound      = !_settingsPending.gifSound;      break;
                                case 3: _settingsPending.negativeGif   = !_settingsPending.negativeGif;   break;
                                case 4: _settingsPending.flipMode      = !_settingsPending.flipMode;      break;
                                case 5: _settingsPending.timeFormat24h = !_settingsPending.timeFormat24h; break;
                            }
                            drawSettingsMenu();
                        } else if (gesture.type == LONG_PRESS) {
                            // De-select row
                            _settingsSelected = false;
                            drawSettingsMenu();
                        }
                    } else {
                        // Browsing mode
                        if (gesture.type == SINGLE_TAP) {
                            // Scroll cursor
                            _settingsCursor = (_settingsCursor + 1) % 8;
                            drawSettingsMenu();
                        } else if (gesture.type == LONG_PRESS) {
                            // Enter/select highlighted row
                            if (_settingsCursor == 0) {
                                // Timer
                                enterTimerSet();
                            } else if (_settingsCursor == 1) {
                                // Game
                                enterGame();
                            } else if (_settingsCursor == 6) {
                                // Save — ask confirmation
                                _settingsConfirming = true;
                                showText("[ Save Settings? ]",
                                         "",
                                         "TAP  = confirm",
                                         "HOLD = cancel");
                            } else if (_settingsCursor == 7) {
                                // Exit — discard changes
                                enterState(GIF_PLAYBACK);
                            } else {
                                // Enter toggle row (cursor 2-5)
                                _settingsSelected = true;
                                drawSettingsMenu();
                            }
                        }
                    }
                    break;

                default:
                    break;

                case TIMER_SET:
                    if (gesture.type == SINGLE_TAP) {
                        switch (_timerField) {
                            case 0: _timerHours   = (_timerHours   + 1) % 24; break;
                            case 1: _timerMinutes = (_timerMinutes  + 1) % 60; break;
                            case 2: _timerSeconds = (_timerSeconds  + 1) % 60; break;
                        }
                        drawTimerSet();
                    } else if (gesture.type == LONG_PRESS) {
                        if (_timerField < 2) {
                            _timerField++;
                            drawTimerSet();
                        } else {
                            uint32_t total = (uint32_t)_timerHours   * 3600
                                           + (uint32_t)_timerMinutes * 60
                                           + (uint32_t)_timerSeconds;
                            if (total == 0) {
                                enterSettingsMenu();
                            } else {
                                _timerRemainSec      = total;
                                _timerLastDisplaySec = UINT32_MAX;
                                _timerDone           = false;
                                _timerStarted        = false;
                                updateAvailable = false;  // don't interrupt timer with update prompt
                                enterState(TIMER_RUNNING);
                                drawTimerRunning(_timerRemainSec, false);
                            }
                        }
                    } else if (gesture.type == DOUBLE_TAP) {
                        enterSettingsMenu();
                    }
                    break;

                case TIMER_RUNNING:
                    if (_timerDone) {
                        if (gesture.type == SINGLE_TAP) {
                            rtttl::stop();
                            noTone(getPinBuzzer());
                            _timerDone = false;
                            enterState(GIF_PLAYBACK);
                        }
                    } else if (!_timerStarted) {
                        if (gesture.type == SINGLE_TAP) {
                            _timerStarted    = true;
                            _timerLastTickMs = millis();
                            drawTimerRunning(_timerRemainSec, true);
                        } else if (gesture.type == LONG_PRESS) {
                            enterTimerSet();
                        }
                    } else {
                        if (gesture.type == SINGLE_TAP ||
                            gesture.type == DOUBLE_TAP ||
                            gesture.type == LONG_PRESS) {
                            rtttl::stop();
                            noTone(getPinBuzzer());
                            _timerDone    = false;
                            _timerStarted = false;
                            enterState(GIF_PLAYBACK);
                        }
                    }
                    break;

                case GAME_RUNNING:
                    if (gesture.type == TOUCH_DOWN) {
                        if (_gameOnGround) {
                            _gameVelY       = -10;
                            _gameOnGround   = false;
                            _gameLastTickMs = millis() - GAME_TICK_MS;
                        }
                    } else if (gesture.type == DOUBLE_TAP) {
                        _gameDucking = true;
                    } else if (gesture.type == LONG_PRESS) {
                        enterState(GIF_PLAYBACK);
                    }
                    break;

                case GAME_OVER:
                    if (now - _stateEntryMs < 1500) break;
                    if (gesture.type == SINGLE_TAP) {
                        enterGame();
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
                if (elapsed >= SETTINGS_MENU_IDLE_MS) {
                    enterState(GIF_PLAYBACK);
                }
                break;

            case TIMER_SET:
                // Idle — redrawn only on gesture
                break;

            case TIMER_RUNNING:
                if (_timerDone) {
                    // Keep looping the alarm melody until user taps to dismiss
                    if (getBuzzerVolume() > 0 && !rtttl::isPlaying()) {
                        noTone(getPinBuzzer());
                        rtttl::begin(getPinBuzzer(), TIMER_MELODY);
                    }
                } else if (_timerStarted && _timerRemainSec > 0) {
                    if (now - _timerLastTickMs >= 1000) {
                        unsigned long ticks = (now - _timerLastTickMs) / 1000;
                        if (ticks > _timerRemainSec) ticks = _timerRemainSec;
                        _timerRemainSec  -= (uint32_t)ticks;
                        _timerLastTickMs += ticks * 1000;
                        if (_timerRemainSec != _timerLastDisplaySec) {
                            _timerLastDisplaySec = _timerRemainSec;
                            drawTimerRunning(_timerRemainSec, true);
                        }
                    }
                } else if (_timerStarted && _timerRemainSec == 0 && !_timerDone) {
                    _timerDone = true;
                    if (getBuzzerVolume() > 0) {
                        noTone(getPinBuzzer());
                        rtttl::begin(getPinBuzzer(), TIMER_MELODY);
                    }
                    showText("[ Timer Done! ]", "", "Time's up!", "TAP to dismiss");
                }
                break;

            case GAME_RUNNING: {
                if (now - _gameLastTickMs < GAME_TICK_MS) break;
                _gameLastTickMs = now;

                // --- Physics --- (move first, then apply gravity)
                if (!_gameOnGround) {
                    _gamePlayerY += _gameVelY;   // move first
                    _gameVelY    += 2;           // then apply gravity
                    int16_t groundY = GAME_GROUND_Y - GAME_CHAR_H + 1;
                    if (_gamePlayerY >= groundY) {
                        _gamePlayerY  = groundY;
                        _gameVelY     = 0;
                        _gameOnGround = true;
                    }
                } else {
                    // Keep clamped every tick so _gamePlayerY is always authoritative
                    _gamePlayerY = GAME_GROUND_Y - GAME_CHAR_H + 1;
                }

                // Duck auto-release after 6 ticks
                static uint8_t duckTicks = 0;
                if (_gameDucking) {
                    duckTicks++;
                    if (duckTicks >= 6) { _gameDucking = false; duckTicks = 0; }
                }

                // --- Move obstacles ---
                for (uint8_t i = 0; i < 2; i++) {
                    if (_gameObs[i].type == OBS_NONE) continue;
                    _gameObs[i].x -= _gameSpeed;
                    if (_gameObs[i].x < -(int16_t)GAME_BIRD_W - 2) {
                        spawnObstacle(_gameObs[i]);
                        _gameScore += 10;  // bonus for clearing obstacle
                    }
                }

                // --- Score / speed increase ---
                _gameScoreTick++;
                if (_gameScoreTick >= 10) {
                    _gameScoreTick = 0;
                    _gameScore++;
                }
                if (_gameSpeed < 8 && _gameScore % GAME_SPEEDUP_AT == 0 && _gameScore > 0) {
                    _gameSpeed++;
                }

                // --- Animation frames ---
                _gameAnimTick++;
                if (_gameAnimTick >= 6) {
                    _gameAnimTick  = 0;
                    _gameCharFrame = 1 - _gameCharFrame;
                    _gameBirdFrame = 1 - _gameBirdFrame;
                }

                // --- Parallax background scroll ---
                _gameStarTick++;
                if (_gameStarTick >= 4) {
                    _gameStarTick = 0;
                    for (uint8_t s = 0; s < GAME_STAR_COUNT; s++) {
                        _gameStarX[s]--;
                        if (_gameStarX[s] < 0) _gameStarX[s] = 127;
                    }
                }
                _gameCloudTick++;
                if (_gameCloudTick >= 2) {
                    _gameCloudTick = 0;
                    for (uint8_t c = 0; c < 2; c++) {
                        _gameClouds[c].x--;
                        if (_gameClouds[c].x < -12) _gameClouds[c].x = 127;
                    }
                }

                // Collision detection
                uint8_t pHeight = _gameDucking ? GAME_CHAR_DUCK_H : GAME_CHAR_H;
                int16_t pTop    = _gameDucking
                                    ? (GAME_GROUND_Y - GAME_CHAR_DUCK_H + 1)
                                    : _gamePlayerY;
                int16_t effectiveX = _gameOnGround ? GAME_PLAYER_X : (GAME_PLAYER_X - 9);
                int16_t pLeft   = effectiveX + 1;
                int16_t pRight  = effectiveX + GAME_CHAR_W - 1;
                int16_t pBottom = pTop + (int16_t)pHeight - 1;

                bool hit = false;
                for (uint8_t i = 0; i < 2; i++) {
                    Obstacle &obs = _gameObs[i];
                    if (obs.type == OBS_NONE) continue;
                    int16_t oLeft, oRight, oTop, oBottom;
                    if (obs.type == OBS_CACTUS_S) {
                        oLeft   = obs.x + 1;
                        oRight  = obs.x + GAME_CACTUS_S_W - 2;
                        oTop    = GAME_GROUND_Y - GAME_CHAR_H + 1;
                        oBottom = GAME_GROUND_Y;
                    } else if (obs.type == OBS_CACTUS_T) {
                        oLeft   = obs.x + 1;
                        oRight  = obs.x + GAME_CACTUS_T_W - 2;
                        oTop    = GAME_GROUND_Y - GAME_CHAR_H + 1;
                        oBottom = GAME_GROUND_Y;
                    } else {
                        if (_gameDucking) continue;
                        oLeft   = obs.x + 2;
                        oRight  = obs.x + GAME_BIRD_W - 3;
                        oTop    = GAME_BIRD_Y + 1;
                        oBottom = GAME_BIRD_Y + GAME_BIRD_H - 2;
                    }
                    if (pRight >= oLeft && pLeft <= oRight &&
                        pBottom >= oTop && pTop <= oBottom) {
                        hit = true;
                        break;
                    }
                }

                if (hit) {
                    setGameHighScore(_gameScore);
                    if (getBuzzerVolume() > 0) {
                        noTone(getPinBuzzer());
                        rtttl::begin(getPinBuzzer(), MUTE_MELODY);
                    }
                    enterState(GAME_OVER);
                    drawGameOver();
                } else {
                    drawGameFrame();
                }
                break;
            }

            case GAME_OVER:
                // Idle — waiting for gesture
                break;

            default:
                break;
        }

        // Short delay to yield CPU
        vTaskDelay(pdMS_TO_TICKS(5));
    }
}
