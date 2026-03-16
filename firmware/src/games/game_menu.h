// ==========================================================================
//  QBIT -- Game selection menu (scrollable list, launch game or back)
// ==========================================================================
#ifndef GAME_MENU_H
#define GAME_MENU_H

#include <Arduino.h>

enum class GameMenuGestureType {
    None, SingleTap, DoubleTap, LongPress
};

enum class GameMenuAction {
    None,           // no action or redraw already done
    Scroll,         // cursor moved (caller redraws)
    Launch0,        // launch game index 0 (T-Rex Runner)
    Launch1,        // launch game index 1 (Flappy Bird)
    Launch2,        // launch game index 2 (Car Avoidance)
    OpenContribute, // open "contribute" hint (fake "More games" item)
    Back            // return to settings
};

// Reset cursor to 0. Call when entering GAME_MENU.
void gameMenuEnter();

// Draw the games list (header + 3 visible rows + hint).
void gameMenuDraw();

// Handle gesture. Returns action; display_task redraws or enters game/settings.
GameMenuAction gameMenuOnGesture(GameMenuGestureType g);

// Number of games (for scroll wrap). Index 0 = T-Rex Runner.
uint8_t gameMenuCount();

#endif // GAME_MENU_H
