// ==========================================================================
//  QBIT -- Flappy Bird game implementation
//  Display: 128x64 OLED, rotated 180° via rotateBuffer180().
//  Tap/TouchUp = flap upward. Avoid pipes and floor.
// ==========================================================================
#include "flappy_bird.h"
#include "app_state.h"
#include "display_helpers.h"
#include "settings.h"
#include <stdio.h>

// --------------------------------------------------------------------------
//  Constants
// --------------------------------------------------------------------------
#define FB_GROUND_Y        63      // Y of the ground line (drawn as a line)

#define FB_BIRD_X          18      // fixed left-edge X of bird sprite
#define FB_BIRD_W          8       // sprite width
#define FB_BIRD_H          6       // sprite height (rows 0-5)

// Collision box (inner padding to keep game fair but forgiving)
#define FB_HIT_L           2       // left padding inside bird sprite
#define FB_HIT_R           2       // right padding inside bird sprite
#define FB_HIT_T           1       // top padding inside bird sprite
#define FB_HIT_B           1       // bottom padding inside bird sprite

#define FB_PIPE_W          10      // pipe body width
#define FB_PIPE_GAP        18      // vertical opening height
#define FB_PIPE_CAP_H      3       // pipe cap height (drawn at gap edge)
#define FB_PIPE_CAP_EXT    1       // cap extends 1 px each side

#define FB_MIN_GAP_TOP     10      // minimum Y for top of gap
#define FB_MAX_GAP_TOP     35      // maximum Y for top of gap
#define FB_PIPE_SPACING    68      // horizontal distance between pipe pairs
#define FB_PIPE_OFFSCREEN  (-(FB_PIPE_W + FB_PIPE_CAP_EXT + 1))

#define FB_TICK_MS         40      // ms per game tick (~25 fps)
// Physics tuning: weaker flap + slightly lower gravity for tighter, more controllable arcs.
#define FB_FLAP_VEL4       (-10)   // upward launch velocity (×4 sub-pixel)
#define FB_GRAVITY4        2       // gravity added to velY each tick (×4)
#define FB_TERM_VEL4       20      // terminal downward velocity (×4)

#define FB_SPEED_INIT      2       // initial pipe scroll speed (px/tick)
#define FB_SPEED_MAX       5       // maximum pipe scroll speed
#define FB_SPEEDUP_PIPES   8       // speed-up every N pipes scored

// --------------------------------------------------------------------------
//  Types
// --------------------------------------------------------------------------
struct FlappyPipe {
    int16_t x;
    int16_t gapTop;   // Y where the gap begins (top pipe ends just above)
    bool    scored;
};

// --------------------------------------------------------------------------
//  State
// --------------------------------------------------------------------------
static int16_t       _birdY4     = 0;   // bird top Y × 4 (sub-pixel)
static int16_t       _velY4      = 0;
static bool          _dead       = false;
static uint8_t       _birdFrame  = 0;   // 0=mid, 1=up, 2=down
static uint8_t       _animTick   = 0;
static uint32_t      _score      = 0;
static uint8_t       _speed      = FB_SPEED_INIT;
static unsigned long _lastTickMs = 0;
static FlappyPipe    _pipes[2];
static uint16_t      _randState  = 1;

// --------------------------------------------------------------------------
//  Simple XOR-shift RNG (same pattern as trex_runner.cpp)
// --------------------------------------------------------------------------
static uint16_t fbRand() {
    if (_randState == 0) _randState = 1;
    _randState ^= _randState << 7;
    _randState ^= _randState >> 9;
    _randState ^= _randState << 8;
    return _randState;
}

// --------------------------------------------------------------------------
//  Bird sprite
//  8 columns wide × 6 rows tall.
//  Each byte = one row; bit 7 = leftmost pixel (col 0), bit 0 = rightmost (col 7).
//  Bird faces right: beak is the rightmost lit pixel on row 3.
//  Eye hole: col 5 on row 2 is 0 (transparent).
// --------------------------------------------------------------------------
//  Col:  0 1 2 3 4 5 6 7
//  Row0: . . X X X . . .   0x38
//  Row1: . X X X X X . .   0x7C
//  Row2: X X X X X . X .   0xFA  ← eye hole at col 5
//  Row3: X X X X X X X X   0xFF  ← beak at col 7 (rightmost)
//  Row4: . X X X X X X .   0x7E
//  Row5: . . X X X X . .   0x3C
static const uint8_t BIRD_BODY[6] = { 0x38, 0x7C, 0xFA, 0xFF, 0x7E, 0x3C };

static void drawBird(int16_t bx, int16_t topY, uint8_t frame, bool dead) {
    u8g2.setDrawColor(1);

    // Draw body rows
    for (int8_t r = 0; r < FB_BIRD_H; r++) {
        int16_t sy = topY + r;
        if (sy < 0 || sy > 63) continue;
        uint8_t bits = BIRD_BODY[r];
        for (int8_t c = 0; c < FB_BIRD_W; c++) {
            if (bits & (0x80 >> c)) {
                int16_t sx = bx + c;
                if (sx >= 0 && sx <= 127)
                    u8g2.drawPixel((uint8_t)sx, (uint8_t)sy);
            }
        }
    }

    if (dead) {
        // X eyes: replace normal eye with × mark
        u8g2.setDrawColor(0);
        u8g2.drawPixel(bx + 5, topY + 2);  // clear body pixel at eye
        u8g2.setDrawColor(1);
        // × pattern around col 5, row 2
        if (topY + 1 >= 0  && topY + 1 <= 63) {
            if (bx + 4 >= 0 && bx + 4 <= 127) u8g2.drawPixel(bx + 4, topY + 1);
            if (bx + 6 >= 0 && bx + 6 <= 127) u8g2.drawPixel(bx + 6, topY + 1);
        }
        if (topY + 3 >= 0 && topY + 3 <= 63) {
            if (bx + 4 >= 0 && bx + 4 <= 127) u8g2.drawPixel(bx + 4, topY + 3);
            if (bx + 6 >= 0 && bx + 6 <= 127) u8g2.drawPixel(bx + 6, topY + 3);
        }
    } else {
        // Wing row: 3-pixel strip outside the body
        if (frame == 1) {
            // Wing up: one row above body
            int16_t wy = topY - 1;
            if (wy >= 0 && wy <= 63) {
                for (int8_t c = 1; c <= 3; c++) {
                    int16_t sx = bx + c;
                    if (sx >= 0 && sx <= 127) u8g2.drawPixel((uint8_t)sx, (uint8_t)wy);
                }
            }
        } else if (frame == 2) {
            // Wing down: one row below body
            int16_t wy = topY + FB_BIRD_H;
            if (wy >= 0 && wy <= 63) {
                for (int8_t c = 1; c <= 3; c++) {
                    int16_t sx = bx + c;
                    if (sx >= 0 && sx <= 127) u8g2.drawPixel((uint8_t)sx, (uint8_t)wy);
                }
            }
        }
        // frame 0: wing mid (no extra pixels — wing is folded)
    }
}

// --------------------------------------------------------------------------
//  Pipe drawing
//  Top pipe:    body y=0..gapTop-CAP_H-1, cap y=gapTop-CAP_H..gapTop-1 (wider)
//  Bottom pipe: cap y=gapTop+GAP..gapTop+GAP+CAP_H-1, body below that
// --------------------------------------------------------------------------
static void drawPipe(const FlappyPipe &p) {
    int16_t px   = p.x;
    int16_t capX = px - FB_PIPE_CAP_EXT;
    int16_t capW = FB_PIPE_W + 2 * FB_PIPE_CAP_EXT;
    int16_t gapBottom = p.gapTop + FB_PIPE_GAP;

    // Clip helper (clips x/w to [0, 128))
    auto drawClippedBox = [](int16_t bx, int16_t by, int16_t bw, int16_t bh) {
        if (by < 0) { bh += by; by = 0; }
        if (bh <= 0 || by >= 64) return;
        if (bh > 64 - by) bh = 64 - by;
        if (bx < 0) { bw += bx; bx = 0; }
        if (bw <= 0 || bx >= 128) return;
        if (bw > 128 - bx) bw = 128 - bx;
        u8g2.drawBox((uint8_t)bx, (uint8_t)by, (uint8_t)bw, (uint8_t)bh);
    };

    u8g2.setDrawColor(1);

    // Top pipe body (y = 0 to gapTop - CAP_H - 1)
    {
        int16_t bodyH = p.gapTop - FB_PIPE_CAP_H;
        if (bodyH > 0)
            drawClippedBox(px, 0, FB_PIPE_W, bodyH);
    }
    // Top pipe cap (y = gapTop - CAP_H to gapTop - 1)
    drawClippedBox(capX, p.gapTop - FB_PIPE_CAP_H, capW, FB_PIPE_CAP_H);

    // Bottom pipe cap (y = gapBottom to gapBottom + CAP_H - 1)
    drawClippedBox(capX, gapBottom, capW, FB_PIPE_CAP_H);
    // Bottom pipe body (y = gapBottom + CAP_H to 63)
    {
        int16_t bodyY = gapBottom + FB_PIPE_CAP_H;
        int16_t bodyH = 64 - bodyY;
        if (bodyH > 0)
            drawClippedBox(px, bodyY, FB_PIPE_W, bodyH);
    }
}

// --------------------------------------------------------------------------
//  Spawn a pipe at the given x position
// --------------------------------------------------------------------------
static void spawnPipe(FlappyPipe &p, int16_t startX) {
    uint16_t r = fbRand();
    p.x       = startX;
    p.gapTop  = FB_MIN_GAP_TOP + (int16_t)(r % (uint16_t)(FB_MAX_GAP_TOP - FB_MIN_GAP_TOP + 1));
    p.scored  = false;
}

// --------------------------------------------------------------------------
//  Public API
// --------------------------------------------------------------------------

void flappyEnter() {
    _randState  = (uint16_t)(millis() & 0xFFFF) | 1;
    _birdY4     = 27 * 4;   // bird top at Y=27, center ≈ Y=30
    _velY4      = 0;
    _dead       = false;
    _birdFrame  = 0;
    _animTick   = 0;
    _score      = 0;
    _speed      = FB_SPEED_INIT;
    _lastTickMs = millis();
    // First pipe spawns far enough right so player has time to react
    spawnPipe(_pipes[0], 140);
    spawnPipe(_pipes[1], 140 + FB_PIPE_SPACING);
}

void flappyDrawFrame(unsigned long /*nowMs*/) {
    u8g2.clearBuffer();
    u8g2.setDrawColor(1);

    // HUD: high score and current score
    {
        char hud[22];
        snprintf(hud, sizeof(hud), "HI %03lu  %03lu",
                 (unsigned long)getFlappyHighScore(), (unsigned long)_score);
        u8g2.setFont(u8g2_font_6x10_tr);
        uint8_t hudW = u8g2.getStrWidth(hud);
        u8g2.drawStr((int16_t)(128 - hudW - 2), 10, hud);
    }

    // Pipes
    for (uint8_t i = 0; i < 2; i++)
        drawPipe(_pipes[i]);

    // Ground line
    u8g2.drawHLine(0, FB_GROUND_Y, 128);

    // Bird
    int16_t birdTopY = _birdY4 / 4;
    drawBird(FB_BIRD_X, birdTopY, _birdFrame, _dead);

    rotateBuffer180();
    u8g2.sendBuffer();
}

void flappyDrawGameOver() {
    u8g2.clearBuffer();
    u8g2.setFont(u8g2_font_6x13_tr);

    const char *hdr = "[ Flappy Bird ]";
    u8g2.drawStr((128 - u8g2.getStrWidth(hdr)) / 2, 13, hdr);

    char scoreLine[20], bestLine[20];
    snprintf(scoreLine, sizeof(scoreLine), "Score: %03lu", (unsigned long)_score);
    snprintf(bestLine,  sizeof(bestLine),  "Best:  %03lu", (unsigned long)getFlappyHighScore());
    u8g2.drawStr((128 - u8g2.getStrWidth(scoreLine)) / 2, 32, scoreLine);
    u8g2.drawStr((128 - u8g2.getStrWidth(bestLine))  / 2, 46, bestLine);

    const char *hint = "TAP=retry  HOLD=exit";
    u8g2.drawStr((128 - u8g2.getStrWidth(hint)) / 2, 62, hint);

    rotateBuffer180();
    u8g2.sendBuffer();
}

FlappyAction flappyOnGesture(FlappyGestureType g) {
    if (g == FlappyGestureType::TouchUp) return FlappyAction::Flap;
    return FlappyAction::None;
}

void flappyApplyFlap() {
    if (_dead) return;
    _velY4     = FB_FLAP_VEL4;
    _birdFrame = 1;   // wing up
    _animTick  = 0;
}

bool flappyTick(unsigned long nowMs) {
    if (nowMs - _lastTickMs < FB_TICK_MS) return false;
    _lastTickMs = nowMs;

    if (_dead) return false;

    // --- Physics ---
    _birdY4 += _velY4;
    _velY4  += FB_GRAVITY4;
    if (_velY4 > FB_TERM_VEL4) _velY4 = FB_TERM_VEL4;

    // Ceiling: clamp and stop vertical velocity
    if (_birdY4 < 0) { _birdY4 = 0; _velY4 = 0; }

    int16_t birdTopY = _birdY4 / 4;
    int16_t birdBotY = birdTopY + FB_BIRD_H - 1;

    // Floor collision
    if (birdBotY >= FB_GROUND_Y) {
        _dead = true;
        return true;
    }

    // --- Scroll pipes ---
    for (uint8_t i = 0; i < 2; i++) {
        _pipes[i].x -= _speed;

        // Respawn pipe when it exits left edge
        if (_pipes[i].x < FB_PIPE_OFFSCREEN) {
            int16_t other = (i == 0) ? _pipes[1].x : _pipes[0].x;
            int16_t spawnX = other + FB_PIPE_SPACING;
            if (spawnX < 130) spawnX = 130;
            spawnPipe(_pipes[i], spawnX);
        }

        // Score: pipe fully passes bird X
        if (!_pipes[i].scored && (_pipes[i].x + FB_PIPE_W) < FB_BIRD_X) {
            _pipes[i].scored = true;
            _score++;
            if (_speed < FB_SPEED_MAX && (_score % FB_SPEEDUP_PIPES) == 0)
                _speed++;
        }
    }

    // --- Pipe collision ---
    // Collision box (inner-padded for fairness)
    int16_t hitLeft  = FB_BIRD_X + FB_HIT_L;
    int16_t hitRight = FB_BIRD_X + FB_BIRD_W - 1 - FB_HIT_R;
    int16_t hitTop   = birdTopY + FB_HIT_T;
    int16_t hitBot   = birdBotY - FB_HIT_B;

    for (uint8_t i = 0; i < 2; i++) {
        const FlappyPipe &p = _pipes[i];
        int16_t pLeft  = p.x;
        int16_t pRight = p.x + FB_PIPE_W - 1;

        // Horizontal overlap?
        if (hitRight < pLeft || hitLeft > pRight) continue;

        // Vertical: is bird's hit-box entirely inside the gap?
        int16_t gapBottom = p.gapTop + FB_PIPE_GAP;
        if (hitTop < p.gapTop || hitBot >= gapBottom) {
            _dead = true;
            return true;
        }
    }

    // --- Animation ---
    _animTick++;
    if (_animTick >= 4) {
        _animTick  = 0;
        _birdFrame = (_birdFrame + 1) % 3;
    }

    return false;
}

uint32_t flappyGetScore() { return _score; }
