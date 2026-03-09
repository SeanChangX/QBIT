// T-Rex Runner (assets: t_rex_runner_assets.h)
#include "game_runner.h"
#include "app_state.h"
#include "display_helpers.h"
#include "t_rex_runner_assets.h"
#include "settings.h"
#include <stdio.h>
#include <pgmspace.h>

#define GAME_GROUND_Y   63
#define GAME_TREX_X     5
#define GAME_TICK_MS    50
#define GAME_SPEED_INIT 5
#define GAME_SPEEDUP_AT 256
#define GAME_SPEED_MAX  12
#define GAME_GROUND_W   64
#define TREX_JUMP_VEL   -13
#define GRAVITY         2
#define GRAVITY_DUCK    8
#define CACTUS_Y        63
#define PTERO_Y1        15
#define PTERO_Y2        25
#define PTERO_Y3        35
#define MIN_GAP         48
#define RESPAWN_WAIT_MIN 15
#define RESPAWN_WAIT_RANGE 35

// T-rex format: first 2 bytes = width, height; data at +2, row-major 8 vertical bits/byte.
// Mask: 1 = transparent (skip). Draw only pixels inside [0,127] x [0,63].
// Use memcpy_P to copy sprite into RAM then draw (reliable on ESP32 with PROGMEM).
#define DINO_BMP_MAX  (64 * 2 + 2)
static void drawDinoBitmap(int16_t px, int16_t py, const uint8_t *bitmap, const uint8_t *mask, bool anchorBottom) {
    uint8_t w = pgm_read_byte(bitmap + 0);
    uint8_t h = pgm_read_byte(bitmap + 1);
    if (w == 0 || h == 0) return;
    uint16_t dataLen = 2 + (uint16_t)((h + 7) / 8) * w;
    if (dataLen > DINO_BMP_MAX) return;
    uint8_t ramBmp[DINO_BMP_MAX];
    memcpy_P(ramBmp, bitmap, dataLen);
    uint8_t ramMsk[DINO_BMP_MAX];
    if (mask) memcpy_P(ramMsk, mask, dataLen);
    const uint8_t *data = ramBmp + 2;
    const uint8_t *msk  = mask ? (ramMsk + 2) : nullptr;
    int16_t top = anchorBottom ? (py - (int16_t)h) : py;
    for (uint8_t y = 0; y < h; y++) {
        int16_t sy = top + y;
        if (sy < 0 || sy > 63) continue;
        uint8_t yByte = y / 8;
        uint8_t yBit  = y % 8;
        uint16_t rowOff = (uint16_t)yByte * w;
        for (uint8_t x = 0; x < w; x++) {
            int16_t sx = px + x;
            if (sx < 0 || sx > 127) continue;
            uint16_t off = rowOff + x;
            if (msk && (msk[off] & (1 << yBit)))
                continue;
            if (data[off] & (1 << yBit))
                u8g2.drawPixel((uint8_t)sx, (uint8_t)sy);
        }
    }
}

enum ObstacleType { OBS_NONE, OBS_CACTUS_SB, OBS_CACTUS_BS, OBS_CACTUS_2B, OBS_CACTUS_3S, OBS_PTERO };
struct Obstacle {
    ObstacleType type;
    int16_t x;
    uint8_t pteroY;  // 0=PTERO_Y1, 1=PTERO_Y2, 2=PTERO_Y3
};

static int16_t obstacleW(ObstacleType t);

static const uint8_t *const CACTI_BMP[] PROGMEM = {
    cacti_small_big_bitmap, cacti_big_small_bitmap, cacti_big_big_bitmap, cacti_small_small_small_bitmap
};
static const uint8_t *const CACTI_MSK[] PROGMEM = {
    cacti_small_big_mask, cacti_big_small_mask, cacti_big_big_mask, cacti_small_small_small_mask
};
static const uint8_t CACTI_W[] = { 23, 23, 27, 27 };
static const uint8_t CACTI_H[] = { 26, 26, 26, 26 };

static int16_t   _trexY       = GAME_GROUND_Y;
static int16_t   _velY        = 0;
static bool      _onGround    = true;
static bool      _ducking     = false;
static bool      _dead        = false;
static uint8_t   _trexFrame   = 0;
static uint8_t   _pteroFrame  = 0;
#define NUM_GROUND_TILES 3
#define GROUND_REARM_X   124
static int16_t   _groundTileX[NUM_GROUND_TILES];
static uint8_t   _groundTileIdx[NUM_GROUND_TILES];
static Obstacle  _obs[2];
static uint8_t   _speed       = GAME_SPEED_INIT;
static uint32_t  _score       = 0;
static unsigned long _lastTickMs = 0;
static uint8_t   _animTick    = 0;
static uint16_t  _randState   = 1;
static uint8_t   _respawnWait[2] = { 0, 0 };
static uint32_t  _gameTicks = 0;

static uint16_t gameRand() {
    if (_randState == 0) _randState = 1;
    _randState ^= _randState << 7;
    _randState ^= _randState >> 9;
    _randState ^= _randState << 8;
    return _randState;
}

static void spawnObstacle(Obstacle &o, uint8_t selfIdx) {
    uint16_t r = gameRand();
    int16_t minX = 128 + MIN_GAP;
    for (uint8_t j = 0; j < 2; j++) {
        if (j != selfIdx && _obs[j].type != OBS_NONE && _obs[j].x < 200)
            minX = (int16_t)(minX > _obs[j].x + obstacleW(_obs[j].type) + MIN_GAP ? minX : _obs[j].x + obstacleW(_obs[j].type) + MIN_GAP);
    }
    o.x = minX + (int16_t)(r % 24);
    uint8_t k = r % 5;
    if (k == 4) {
        o.type = OBS_PTERO;
        o.pteroY = (uint8_t)(r % 3);
    } else {
        o.type = (ObstacleType)((uint8_t)OBS_CACTUS_SB + (k % 4));
    }
}

static int16_t obstacleW(ObstacleType t) {
    if (t == OBS_PTERO) return 23;
    if (t == OBS_CACTUS_SB) return CACTI_W[0];
    if (t == OBS_CACTUS_BS) return CACTI_W[1];
    if (t == OBS_CACTUS_2B) return CACTI_W[2];
    return CACTI_W[3];
}

static int16_t obstacleH(ObstacleType t) {
    if (t == OBS_PTERO) return 20;
    return 26;
}

void gameRunnerEnter() {
    _randState   = (uint16_t)(millis() & 0xFFFF) | 1;
    _trexY       = GAME_GROUND_Y;
    _velY        = 0;
    _onGround    = true;
    _ducking     = false;
    _dead        = false;
    _trexFrame   = 0;
    _pteroFrame  = 0;
    _groundTileX[0] = GROUND_REARM_X;
    _groundTileX[1] = 61;
    _groundTileX[2] = -3;
    for (uint8_t i = 0; i < NUM_GROUND_TILES; i++) _groundTileIdx[i] = (uint8_t)(gameRand() % 5);
    _score       = 0;
    _speed       = GAME_SPEED_INIT;
    _lastTickMs  = millis();
    _animTick    = 0;
    _obs[0] = { OBS_CACTUS_SB, 200, 0 };
    _obs[1] = { OBS_NONE, 400, 0 };
    _respawnWait[0] = 0;
    _respawnWait[1] = 0;
    _gameTicks = 0;
}

/* Ground: 3 tiles like t-rex-duino. Each scrolls left with obstacles; when off left, rearm at right (GROUND_REARM_X). */
static void drawGround() {
    const uint8_t *gbm[] = { ground_1_bitmap, ground_2_bitmap, ground_3_bitmap, ground_4_bitmap, ground_5_bitmap };
    for (uint8_t i = 0; i < NUM_GROUND_TILES; i++) {
        int16_t gx = _groundTileX[i];
        if (gx + GAME_GROUND_W > 0 && gx < 128)
            drawDinoBitmap(gx, (int16_t)GAME_GROUND_Y, gbm[_groundTileIdx[i]], nullptr, true);
    }
}

void gameRunnerDrawFrame(unsigned long nowMs) {
    u8g2.clearBuffer();
    u8g2.setDrawColor(1);

    char hud[24];
    snprintf(hud, sizeof(hud), "HI %05lu %05lu", (unsigned long)getGameHighScore(), (unsigned long)_score);
    u8g2.setFont(u8g2_font_6x10_tr);
    uint8_t hudW = u8g2.getStrWidth(hud);
    u8g2.drawStr((int16_t)(128 - hudW - 4), 10, hud);

    drawGround();

    if (_dead) {
        if (_ducking)
            drawDinoBitmap(GAME_TREX_X, GAME_GROUND_Y, trex_dead_2s_no_outline_bitmap, nullptr, true);
        else
            drawDinoBitmap(GAME_TREX_X, GAME_GROUND_Y, trex_dead_1s_no_outline_bitmap, nullptr, true);
    } else if (_ducking) {
        const uint8_t *bm = (_trexFrame & 1) ? trex_duck_2s_bitmap : trex_duck_1s_bitmap;
        int16_t dy = _onGround ? GAME_GROUND_Y : _trexY;
        drawDinoBitmap(GAME_TREX_X, dy, bm, nullptr, true);
    } else {
        const uint8_t *bm = trex_up_1s_bitmap;
        if (_trexFrame == 1) bm = trex_up_2s_bitmap;
        else if (_trexFrame == 2) bm = trex_up_3s_bitmap;
        drawDinoBitmap(GAME_TREX_X, _trexY, bm, nullptr, true);
    }

    for (uint8_t i = 0; i < 2; i++) {
        Obstacle &o = _obs[i];
        if (o.type == OBS_NONE || o.x > 127) continue;
        if (o.type == OBS_PTERO) {
            int16_t py = (o.pteroY == 0) ? PTERO_Y1 : (o.pteroY == 1) ? PTERO_Y2 : PTERO_Y3;
            const uint8_t *bm = _pteroFrame ? pterodactyl_2_bitmap : pterodactyl_1_bitmap;
            drawDinoBitmap(o.x, py + 20, bm, nullptr, true);
        } else {
            uint8_t idx = (uint8_t)o.type - (uint8_t)OBS_CACTUS_SB;
            const uint8_t *cbm = (const uint8_t*)pgm_read_ptr(&CACTI_BMP[idx]);
            drawDinoBitmap(o.x, CACTUS_Y, cbm, nullptr, true);
        }
    }
    rotateBuffer180();
    u8g2.sendBuffer();
}

void gameRunnerDrawGameOver() {
    u8g2.clearBuffer();
    u8g2.setFont(u8g2_font_6x13_tr);
    const char *hdr = "[ T-Rex Runner ]";
    u8g2.drawStr((128 - u8g2.getStrWidth(hdr)) / 2, 13, hdr);
    char scoreLine[20], bestLine[20];
    snprintf(scoreLine, sizeof(scoreLine), "Score: %05lu", (unsigned long)_score);
    snprintf(bestLine,  sizeof(bestLine),  "Best:  %05lu", (unsigned long)getGameHighScore());
    u8g2.drawStr((128 - u8g2.getStrWidth(scoreLine)) / 2, 32, scoreLine);
    u8g2.drawStr((128 - u8g2.getStrWidth(bestLine))  / 2, 46, bestLine);
    const char *hint = "TAP=retry  HOLD=exit";
    u8g2.drawStr((128 - u8g2.getStrWidth(hint)) / 2, 62, hint);
    rotateBuffer180();
    u8g2.sendBuffer();
}

GameRunnerAction gameRunnerOnGesture(GameRunnerGestureType g) {
    if (g == GameRunnerGestureType::TouchDown) return GameRunnerAction::Duck;
    if (g == GameRunnerGestureType::TouchUp) return GameRunnerAction::Jump;
    if (g == GameRunnerGestureType::SingleTap) return GameRunnerAction::None;
    if (g == GameRunnerGestureType::DoubleTap) return GameRunnerAction::None;
    if (g == GameRunnerGestureType::LongPress) return GameRunnerAction::None;
    return GameRunnerAction::None;
}

static bool trexAABB(int16_t tx, int16_t ty, uint8_t tw, uint8_t th, bool trexDuck,
                     int16_t ox, int16_t oy, int16_t ow, int16_t oh) {
    int16_t pad = 6;
    int16_t tLeft = tx + pad;
    int16_t tRight = tx + tw - pad;
    int16_t tTop = ty - th + pad;
    int16_t tBottom = ty - pad;
    if (trexDuck) { tTop = ty - 15 + pad; }
    int16_t oLeft = ox + pad;
    int16_t oRight = ox + ow - pad;
    int16_t oTop = oy - oh + pad;
    int16_t oBottom = oy - pad;
    return tRight >= oLeft && tLeft <= oRight && tBottom >= oTop && tTop <= oBottom;
}

bool gameRunnerTick(unsigned long nowMs) {
    if (nowMs - _lastTickMs < GAME_TICK_MS) return false;
    _lastTickMs = nowMs;

    if (_dead) return false;

    if (!_onGround) {
        if (_ducking && _velY < 0) _velY = 0;
        _trexY += _velY;
        _velY += GRAVITY;
        if (_ducking) _velY += GRAVITY_DUCK;
        if (_trexY >= GAME_GROUND_Y) {
            _trexY = GAME_GROUND_Y;
            _velY = 0;
            _onGround = true;
        }
    }

    for (uint8_t i = 0; i < NUM_GROUND_TILES; i++) {
        _groundTileX[i] -= _speed;
        if (_groundTileX[i] < -GAME_GROUND_W) {
            _groundTileX[i] = GROUND_REARM_X;
            _groundTileIdx[i] = (uint8_t)(gameRand() % 5);
        }
    }

    for (uint8_t i = 0; i < 2; i++) {
        _obs[i].x -= _speed;
        if (_obs[i].x < -50) {
            if (_respawnWait[i] > 0) {
                _respawnWait[i]--;
            } else {
                spawnObstacle(_obs[i], i);
                _respawnWait[i] = RESPAWN_WAIT_MIN + (uint8_t)(gameRand() % RESPAWN_WAIT_RANGE);
            }
        }
    }

    if (_score < 0xFFF0u) _score++;
    _gameTicks++;
    if (_speed < GAME_SPEED_MAX && _gameTicks > 0 && (_gameTicks % GAME_SPEEDUP_AT) == 0)
        _speed++;

    _animTick++;
    if (_animTick >= 4) {
        _animTick = 0;
        if (_onGround && !_ducking) _trexFrame = (_trexFrame + 1) % 3;
        _pteroFrame = 1 - _pteroFrame;
    }

    bool duckOnGround = _ducking && _onGround;
    uint8_t trexH = duckOnGround ? 15 : 23;
    for (uint8_t i = 0; i < 2; i++) {
        Obstacle &o = _obs[i];
        if (o.type == OBS_NONE) continue;
        int16_t ow = obstacleW(o.type);
        int16_t oh = obstacleH(o.type);
        if (o.type == OBS_PTERO) {
            int16_t py = (o.pteroY == 0) ? PTERO_Y1 : (o.pteroY == 1) ? PTERO_Y2 : PTERO_Y3;
            if (trexAABB(GAME_TREX_X, _trexY, 22, trexH, duckOnGround, o.x, py + 20, 23, 20))
                return true;
        } else {
            if (trexAABB(GAME_TREX_X, _trexY, 22, trexH, duckOnGround, o.x, CACTUS_Y, ow, oh))
                return true;
        }
    }
    return false;
}

uint32_t gameRunnerGetScore() { return _score; }

void gameRunnerApplyJump() {
    if (_onGround && !_dead) {
        _velY = TREX_JUMP_VEL;
        _onGround = false;
        _lastTickMs = millis() - GAME_TICK_MS;
    }
}

void gameRunnerApplyDuck() { _ducking = true; }

void gameRunnerApplyRelease() { _ducking = false; }
