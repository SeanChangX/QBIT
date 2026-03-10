// ==========================================================================
//  QBIT -- Flappy Bird (128x64, tap to flap through pipe gaps)
// ==========================================================================
#ifndef FLAPPY_BIRD_H
#define FLAPPY_BIRD_H

#include <Arduino.h>

enum class FlappyGestureType {
    None, TouchDown, TouchUp, SingleTap, DoubleTap, LongPress
};

enum class FlappyAction {
    None, Flap, Exit
};

// Reset state and spawn first pipes. Call before entering FLAPPY_RUNNING.
void flappyEnter();

// Draw current frame (score, pipes, bird). nowMs is kept for API consistency.
void flappyDrawFrame(unsigned long nowMs = 0);

// Draw game over screen (score + best). Call after entering FLAPPY_OVER.
void flappyDrawGameOver();

// Run one game tick (physics, pipes, collision). Returns true if game over.
bool flappyTick(unsigned long nowMs);

// Current score (read after flappyTick() returns true before saving high score).
uint32_t flappyGetScore();

// Handle gesture during play. Returns Flap to trigger a flap.
FlappyAction flappyOnGesture(FlappyGestureType g);

// Apply flap impulse (call when OnGesture returns Flap).
void flappyApplyFlap();

#endif // FLAPPY_BIRD_H
