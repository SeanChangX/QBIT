// ==========================================================================
//  QBIT -- Car Avoidance game implementation
//  Display: 128x64 OLED.
//  Tap/TouchUp = change to next lane (0→1→2→0).
//  Avoid enemy cars scrolling from the top; survive as long as possible.
// ==========================================================================
#include "car_avoidance.h"
#include "app_state.h"
#include "display_helpers.h"
#include "settings.h"
#include <stdio.h>

// --------------------------------------------------------------------------
//  Constants
// --------------------------------------------------------------------------

// Road geometry
#define CA_ROAD_X           22      // X of left road wall pixel
#define CA_ROAD_W           84      // total road width including both wall pixels (3×28)
#define CA_LANE_W           28      // width of each lane in pixels
#define CA_NUM_LANES        3

// Road vertical extents
#define CA_ROAD_TOP_Y       10      // Y of top border line
#define CA_ROAD_BTM_Y       57      // Y of bottom border line

// Car sprite dimensions
#define CA_CAR_W            8       // sprite width for both player and enemy
#define CA_CAR_H            12      // player car sprite height
#define CA_ENEMY_H          10      // enemy car sprite height

// Player car: fixed near the bottom of the road area
// bottom = CA_PLAYER_TOP_Y + CA_CAR_H - 1 = 55  (inside road at y<57)
#define CA_PLAYER_TOP_Y     44

// Enemy car lifecycle
#define CA_SPAWN_Y          (CA_ROAD_TOP_Y + 1)   // just inside top border
#define CA_DESPAWN_Y        CA_ROAD_BTM_Y          // removed when y reaches bottom border

#define CA_MAX_ENEMIES      4

// Timing
#define CA_TICK_MS          35      // ms per tick (~28 fps)

// Difficulty scaling
#define CA_SPEED_INIT       2       // starting scroll speed (px/tick)
#define CA_SPEED_MAX        6       // maximum scroll speed
#define CA_SPEEDUP_SCORE    80      // gain one speed level per 80 score points

// Spawn interval limits (in ticks)
#define CA_SPAWN_MIN_TICKS  8
#define CA_SPAWN_MAX_TICKS  22

// Near-miss: adjacent-lane enemy within this many pixels vertically of player box
#define CA_NEAR_MISS_PX     5

// Road lane-divider dash animation
#define CA_DASH_PERIOD      12      // pixels per dash cycle (on + off)
#define CA_DASH_ON          6       // pixels lit per cycle

// --------------------------------------------------------------------------
//  Lane car-left-edge look-up table
//  Lane n center = CA_ROAD_X + n*CA_LANE_W + CA_LANE_W/2
//  Car left    = center - CA_CAR_W/2
//  Lane 0: center=36 → left=32 | Lane 1: center=64 → left=60 | Lane 2: center=92 → left=88
// --------------------------------------------------------------------------
static const int8_t CA_LANE_X[CA_NUM_LANES] = { 32, 60, 88 };

// Lane divider X positions (interior, between pairs of adjacent lanes)
static const uint8_t CA_DIV_X[CA_NUM_LANES - 1] = { 50, 78 };

// --------------------------------------------------------------------------
//  Sprites
//  Each byte = one row; bit 7 = leftmost pixel (col 0), bit 0 = rightmost (col 7).
//  Stored in flash with PROGMEM; read with pgm_read_byte().
// --------------------------------------------------------------------------

// Player car (8W × 12H): top-down view, front of car faces UP (toward enemies).
//  Row  0: .XXXXXX.  0x7E  front bumper / headlights
//  Row  1: XXXXXXXX  0xFF  hood
//  Row  2: X.XXXX.X  0xBD  windshield frame
//  Row  3: X.XXXX.X  0xBD  windshield frame
//  Row  4: XXXXXXXX  0xFF  dashboard
//  Row  5: XX.XX.XX  0xDB  driver + passenger
//  Row  6: XXXXXXXX  0xFF  rear seat area
//  Row  7: X.XXXX.X  0xBD  rear windshield frame
//  Row  8: X.XXXX.X  0xBD  rear windshield frame
//  Row  9: XXXXXXXX  0xFF  trunk
//  Row 10: X..XX..X  0x99  rear wheel arches
//  Row 11: .XXXXXX.  0x7E  tail lights / rear bumper
static const uint8_t PLAYER_CAR[CA_CAR_H] PROGMEM = {
    0x7E, 0xFF, 0xBD, 0xBD,
    0xFF, 0xDB, 0xFF, 0xBD,
    0xBD, 0xFF, 0x99, 0x7E
};

// Enemy car (8W × 10H): traveling downward.
// Front of car faces DOWN (bottom of sprite), rear faces UP (top of sprite).
//  Row  0: .XXXXXX.  0x7E  tail lights / rear bumper  (top = furthest from player)
//  Row  1: X..XX..X  0x99  rear wheel arches
//  Row  2: XXXXXXXX  0xFF  trunk
//  Row  3: X.XXXX.X  0xBD  rear windshield frame
//  Row  4: X.XXXX.X  0xBD  rear windshield frame
//  Row  5: XXXXXXXX  0xFF  body
//  Row  6: XX.XX.XX  0xDB  seats
//  Row  7: XXXXXXXX  0xFF  hood
//  Row  8: X..XX..X  0x99  front wheel arches
//  Row  9: .XXXXXX.  0x7E  front bumper / headlights  (bottom = closest to player)
static const uint8_t ENEMY_CAR[CA_ENEMY_H] PROGMEM = {
    0x7E, 0x99, 0xFF, 0xBD,
    0xBD, 0xFF, 0xDB, 0xFF,
    0x99, 0x7E
};

// --------------------------------------------------------------------------
//  Types
// --------------------------------------------------------------------------
struct EnemyCar {
    int16_t y;
    uint8_t lane;
    bool    active;
    bool    nearMissed;  // true once near-miss sound has been triggered for this car
};

// --------------------------------------------------------------------------
//  State
// --------------------------------------------------------------------------
static uint8_t       _playerLane    = 1;
static bool          _dead          = false;
static uint32_t      _score         = 0;
static uint8_t       _speed         = CA_SPEED_INIT;
static unsigned long _lastTickMs    = 0;
static EnemyCar      _enemies[CA_MAX_ENEMIES];
static uint16_t      _randState     = 1;
static int16_t       _dashOffset    = 0;
static uint8_t       _spawnTimer    = 0;       // ticks until next spawn attempt
static uint8_t       _spawnInterval = CA_SPAWN_MAX_TICKS;
static bool          _nearMiss      = false;

// --------------------------------------------------------------------------
//  XOR-shift RNG (same pattern as flappy_bird.cpp)
// --------------------------------------------------------------------------
static uint16_t caRand() {
    if (_randState == 0) _randState = 1;
    _randState ^= _randState << 7;
    _randState ^= _randState >> 9;
    _randState ^= _randState << 8;
    return _randState;
}

// --------------------------------------------------------------------------
//  Draw one car sprite, clipped to road interior
// --------------------------------------------------------------------------
static void drawCar(int8_t left, int16_t top, const uint8_t *sprite, uint8_t h) {
    u8g2.setDrawColor(1);
    for (uint8_t row = 0; row < h; row++) {
        int16_t sy = top + (int16_t)row;
        if (sy <= CA_ROAD_TOP_Y || sy >= CA_ROAD_BTM_Y) continue;
        uint8_t bits = pgm_read_byte(&sprite[row]);
        for (uint8_t col = 0; col < CA_CAR_W; col++) {
            if (bits & (0x80u >> col)) {
                int16_t sx = (int16_t)left + (int16_t)col;
                if (sx > CA_ROAD_X && sx < CA_ROAD_X + (int16_t)CA_ROAD_W - 1)
                    u8g2.drawPixel((uint8_t)sx, (uint8_t)sy);
            }
        }
    }
}

// --------------------------------------------------------------------------
//  Draw scrolling road (borders + dashed lane dividers)
// --------------------------------------------------------------------------
static void drawRoad() {
    u8g2.setDrawColor(1);

    // Horizontal border lines
    u8g2.drawHLine(CA_ROAD_X, CA_ROAD_TOP_Y, CA_ROAD_W);
    u8g2.drawHLine(CA_ROAD_X, CA_ROAD_BTM_Y, CA_ROAD_W);

    // Vertical road walls
    u8g2.drawVLine(CA_ROAD_X,
                   CA_ROAD_TOP_Y, CA_ROAD_BTM_Y - CA_ROAD_TOP_Y + 1);
    u8g2.drawVLine(CA_ROAD_X + CA_ROAD_W - 1,
                   CA_ROAD_TOP_Y, CA_ROAD_BTM_Y - CA_ROAD_TOP_Y + 1);

    // Dashed lane dividers — dash offset scrolls to simulate forward motion
    for (uint8_t d = 0; d < (uint8_t)(CA_NUM_LANES - 1); d++) {
        uint8_t dx = CA_DIV_X[d];
        for (int16_t y = CA_ROAD_TOP_Y + 1; y < CA_ROAD_BTM_Y; y++) {
            uint8_t phase = (uint8_t)((uint16_t)(y + _dashOffset) % CA_DASH_PERIOD);
            if (phase < CA_DASH_ON)
                u8g2.drawPixel(dx, (uint8_t)y);
        }
    }
}

// --------------------------------------------------------------------------
//  Spawn one enemy car if a slot is free and lane spacing allows
// --------------------------------------------------------------------------
static void spawnEnemy() {
    // Find a free slot
    int8_t slot = -1;
    for (uint8_t i = 0; i < CA_MAX_ENEMIES; i++) {
        if (!_enemies[i].active) { slot = i; break; }
    }
    if (slot < 0) return;

    // Pick a random lane; retry up to 3 times to avoid crowding the spawn row
    uint8_t lane = 0;
    for (uint8_t attempt = 0; attempt < 3; attempt++) {
        lane = (uint8_t)(caRand() % CA_NUM_LANES);
        bool blocked = false;
        for (uint8_t i = 0; i < CA_MAX_ENEMIES; i++) {
            if (_enemies[i].active && _enemies[i].lane == lane &&
                _enemies[i].y < CA_ROAD_TOP_Y + CA_ENEMY_H + 4) {
                blocked = true;
                break;
            }
        }
        if (!blocked) break;
    }

    _enemies[slot] = { (int16_t)CA_SPAWN_Y, lane, true, false };
}

// --------------------------------------------------------------------------
//  Public API
// --------------------------------------------------------------------------

void carAvoidanceEnter() {
    _randState     = (uint16_t)(millis() & 0xFFFF) | 1;
    _playerLane    = 1;
    _dead          = false;
    _score         = 0;
    _speed         = CA_SPEED_INIT;
    _lastTickMs    = millis();
    _dashOffset    = 0;
    _spawnTimer    = 10;                    // short delay before first enemy
    _spawnInterval = CA_SPAWN_MAX_TICKS;
    _nearMiss      = false;
    for (uint8_t i = 0; i < CA_MAX_ENEMIES; i++)
        _enemies[i].active = false;
}

void carAvoidanceDrawFrame(unsigned long /*nowMs*/) {
    u8g2.clearBuffer();
    u8g2.setDrawColor(1);

    // HUD: high score and current score (right-aligned, matching Flappy Bird style)
    char hud[24];
    snprintf(hud, sizeof(hud), "HI %04lu  %04lu",
             (unsigned long)getCarHighScore(), (unsigned long)_score);
    u8g2.setFont(u8g2_font_6x10_tr);
    uint8_t hudW = u8g2.getStrWidth(hud);
    u8g2.drawStr((int16_t)(128 - (int16_t)hudW - 2), 9, hud);

    // Road
    drawRoad();

    // Enemy cars
    for (uint8_t i = 0; i < CA_MAX_ENEMIES; i++) {
        if (_enemies[i].active)
            drawCar(CA_LANE_X[_enemies[i].lane], _enemies[i].y,
                    ENEMY_CAR, CA_ENEMY_H);
    }

    // Player car
    drawCar(CA_LANE_X[_playerLane], CA_PLAYER_TOP_Y, PLAYER_CAR, CA_CAR_H);

    rotateBuffer180();
    u8g2.sendBuffer();
}

void carAvoidanceDrawGameOver() {
    u8g2.clearBuffer();
    u8g2.setFont(u8g2_font_6x13_tr);

    const char *hdr = "[ Car Avoidance ]";
    u8g2.drawStr((128 - (int16_t)u8g2.getStrWidth(hdr)) / 2, 13, hdr);

    char scoreLine[20], bestLine[20];
    snprintf(scoreLine, sizeof(scoreLine), "Score: %04lu", (unsigned long)_score);
    snprintf(bestLine,  sizeof(bestLine),  "Best:  %04lu", (unsigned long)getCarHighScore());
    u8g2.drawStr((128 - (int16_t)u8g2.getStrWidth(scoreLine)) / 2, 32, scoreLine);
    u8g2.drawStr((128 - (int16_t)u8g2.getStrWidth(bestLine))  / 2, 46, bestLine);

    const char *hint = "TAP=retry  HOLD=exit";
    u8g2.drawStr((128 - (int16_t)u8g2.getStrWidth(hint)) / 2, 62, hint);

    rotateBuffer180();
    u8g2.sendBuffer();
}

CarAction carAvoidanceOnGesture(CarGestureType g) {
    if (g == CarGestureType::TouchUp || g == CarGestureType::SingleTap)
        return CarAction::ChangeLane;
    if (g == CarGestureType::LongPress)
        return CarAction::Exit;
    return CarAction::None;
}

void carAvoidanceApplyChangeLane() {
    if (_dead) return;
    _playerLane = (_playerLane + 1) % CA_NUM_LANES;
}

bool carAvoidanceTick(unsigned long nowMs) {
    if (nowMs - _lastTickMs < CA_TICK_MS) return false;
    _lastTickMs = nowMs;

    if (_dead) return false;

    _score++;

    // Speed: one level per CA_SPEEDUP_SCORE points, capped at CA_SPEED_MAX
    uint8_t newSpeed = (uint8_t)(CA_SPEED_INIT + _score / CA_SPEEDUP_SCORE);
    if (newSpeed > CA_SPEED_MAX) newSpeed = CA_SPEED_MAX;
    _speed = newSpeed;

    // Tighten spawn interval as speed grows
    int8_t spawnAdj = (int8_t)(CA_SPAWN_MAX_TICKS - (_speed - CA_SPEED_INIT) * 3);
    _spawnInterval = (spawnAdj < (int8_t)CA_SPAWN_MIN_TICKS)
                     ? CA_SPAWN_MIN_TICKS : (uint8_t)spawnAdj;

    // Scroll road dash pattern
    _dashOffset = (int16_t)(((int32_t)_dashOffset + _speed) % CA_DASH_PERIOD);

    // Spawn timer
    if (_spawnTimer > 0) {
        _spawnTimer--;
    } else {
        spawnEnemy();
        _spawnTimer = _spawnInterval + (uint8_t)(caRand() % (_spawnInterval / 2 + 1));
    }

    // Player hitbox
    int16_t pLeft = (int16_t)CA_LANE_X[_playerLane];
    int16_t pTop  = (int16_t)CA_PLAYER_TOP_Y;
    int16_t pBtm  = pTop + (int16_t)CA_CAR_H - 1;

    _nearMiss = false;
    bool crashed = false;

    for (uint8_t i = 0; i < CA_MAX_ENEMIES && !crashed; i++) {
        if (!_enemies[i].active) continue;

        _enemies[i].y += (int16_t)_speed;

        // Despawn once past bottom border
        if (_enemies[i].y >= (int16_t)CA_DESPAWN_Y) {
            _enemies[i].active = false;
            continue;
        }

        int16_t eTop = _enemies[i].y;
        int16_t eBtm = eTop + (int16_t)CA_ENEMY_H - 1;

        // Collision — same lane; X overlap guaranteed for same lane, check Y only
        if (_enemies[i].lane == _playerLane) {
            if (eTop <= pBtm && eBtm >= pTop) {
                crashed = true;
                _dead   = true;
            }
        }

        // Near-miss — adjacent lane, vertically close to player
        if (!_enemies[i].nearMissed && !crashed) {
            int8_t laneDiff = (int8_t)_enemies[i].lane - (int8_t)_playerLane;
            if (laneDiff == 1 || laneDiff == -1) {
                if (eBtm >= pTop - (int16_t)CA_NEAR_MISS_PX &&
                    eTop <= pBtm + (int16_t)CA_NEAR_MISS_PX) {
                    _enemies[i].nearMissed = true;
                    _nearMiss = true;
                }
            }
        }
    }

    return crashed;
}

bool carAvoidanceNearMiss() {
    return _nearMiss;
}

uint32_t carAvoidanceGetScore() {
    return _score;
}
