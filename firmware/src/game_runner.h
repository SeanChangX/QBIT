// ==========================================================================
//  QBIT -- T-Rex Runner (128x64, jump/duck obstacles)
// ==========================================================================
#ifndef GAME_RUNNER_H
#define GAME_RUNNER_H

#include <Arduino.h>

enum class GameRunnerGestureType {
    None, TouchDown, TouchUp, SingleTap, DoubleTap, LongPress
};

enum class GameRunnerAction {
    None, Jump, Duck, Exit
};

// Reset state and spawn first obstacle. Call before entering GAME_RUNNING.
void gameRunnerEnter();

// Draw current frame (score, ground, player, obstacles). nowMs is unused (kept for API).
void gameRunnerDrawFrame(unsigned long nowMs = 0);

// Draw game over screen (score + best). Call after entering GAME_OVER.
void gameRunnerDrawGameOver();

// Run one game tick (physics, obstacles, collision). Returns true if game over.
bool gameRunnerTick(unsigned long nowMs);

// Current score (read after gameRunnerTick() returns true for new high score save).
uint32_t gameRunnerGetScore();

// Handle gesture during play. Caller applies Jump/Duck. Exit is not returned during play (exit only by dying).
GameRunnerAction gameRunnerOnGesture(GameRunnerGestureType g);

// Apply jump, duck, or release. Caller calls ApplyRelease() on TouchUp, then ApplyJump() if OnGesture returned Jump.
void gameRunnerApplyJump();
void gameRunnerApplyDuck();
void gameRunnerApplyRelease();

#endif // GAME_RUNNER_H
