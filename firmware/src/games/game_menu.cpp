// ==========================================================================
//  QBIT -- Game selection menu implementation
// ==========================================================================
#include "game_menu.h"
#include "app_state.h"
#include "display_helpers.h"
#include <stdio.h>

static const char *GAME_MENU_LABELS[] = {
    "T-Rex Runner",
    "Flappy Bird",
    "Car Avoidance",
    "More games",
};
static const uint8_t GAME_MENU_COUNT_VAL = 4;

static uint8_t _cursor = 0;

void gameMenuEnter() {
    _cursor = 0;
}

void gameMenuDraw() {
    u8g2.clearBuffer();
    u8g2.setFont(u8g2_font_6x13_tr);

    const char *hdr = "[ Games ]";
    u8g2.drawStr((128 - u8g2.getStrWidth(hdr)) / 2, 13, hdr);

    // Scrolling window: show up to 2 rows at a time to leave space for footer hint.
    const uint8_t VISIBLE_ROWS   = 2;
    const uint8_t ROW_START_Y    = 29;
    const uint8_t ROW_HEIGHT     = 16;  // more vertical padding to avoid overlap with footer

    uint8_t top = 0;
    if (GAME_MENU_COUNT_VAL > VISIBLE_ROWS) {
        // Keep cursor within the visible window, clamped to valid range.
        if (_cursor >= VISIBLE_ROWS) {
            top = _cursor - (VISIBLE_ROWS - 1);
            uint8_t maxTop = (uint8_t)(GAME_MENU_COUNT_VAL - VISIBLE_ROWS);
            if (top > maxTop) top = maxTop;
        }
    }

    for (uint8_t row = 0; row < VISIBLE_ROWS; row++) {
        uint8_t item = top + row;
        if (item >= GAME_MENU_COUNT_VAL) break;

        uint8_t y = ROW_START_Y + row * ROW_HEIGHT;
        bool isSelected = (item == _cursor);

        if (isSelected) {
            u8g2.setDrawColor(1);
            u8g2.drawBox(0, y - 12, 128, 14);
            u8g2.setDrawColor(0);
        } else {
            u8g2.setDrawColor(1);
        }

        char buf[24];
        snprintf(buf, sizeof(buf), "%-18s", GAME_MENU_LABELS[item]);
        u8g2.drawStr(6, y, buf);
    }

    u8g2.setDrawColor(1);
    const char *hint = "HOLD=play  DBL=back";
    u8g2.drawStr((128 - u8g2.getStrWidth(hint)) / 2, 62, hint);

    rotateBuffer180();
    u8g2.sendBuffer();
}

GameMenuAction gameMenuOnGesture(GameMenuGestureType g) {
    if (g == GameMenuGestureType::SingleTap) {
        _cursor = (_cursor + 1) % GAME_MENU_COUNT_VAL;
        return GameMenuAction::Scroll;
    }
    if (g == GameMenuGestureType::LongPress) {
        if (_cursor == 0) return GameMenuAction::Launch0;
        if (_cursor == 1) return GameMenuAction::Launch1;
        if (_cursor == 2) return GameMenuAction::Launch2;
        if (_cursor == 3) return GameMenuAction::OpenContribute;
        return GameMenuAction::None;
    }
    if (g == GameMenuGestureType::DoubleTap)
        return GameMenuAction::Back;
    return GameMenuAction::None;
}

uint8_t gameMenuCount() {
    return GAME_MENU_COUNT_VAL;
}
