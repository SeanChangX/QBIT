// ==========================================================================
//  QBIT -- Car Avoidance (128x64, tap to change lanes, avoid enemy cars)
// ==========================================================================
#ifndef CAR_AVOIDANCE_H
#define CAR_AVOIDANCE_H

#include <Arduino.h>

enum class CarGestureType {
    None, TouchDown, TouchUp, SingleTap, DoubleTap, LongPress
};

enum class CarAction {
    None, ChangeLane, Exit
};

// Reset state. Call before entering CAR_RUNNING.
void carAvoidanceEnter();

// Draw current frame (HUD, road, cars). nowMs is kept for API consistency.
void carAvoidanceDrawFrame(unsigned long nowMs = 0);

// Draw game over screen (score + best). Call after entering CAR_OVER.
void carAvoidanceDrawGameOver();

// Run one game tick (scroll, spawn, collision). Returns true if game over (crash).
bool carAvoidanceTick(unsigned long nowMs);

// Returns true if a near-miss was detected on the most recent tick.
bool carAvoidanceNearMiss();

// Current score (read after carAvoidanceTick() returns true before saving high score).
uint32_t carAvoidanceGetScore();

// Handle gesture during play. Returns ChangeLane or Exit.
CarAction carAvoidanceOnGesture(CarGestureType g);

// Apply lane change (cycle right: lane 0→1→2→0).
void carAvoidanceApplyChangeLane();

#endif // CAR_AVOIDANCE_H
