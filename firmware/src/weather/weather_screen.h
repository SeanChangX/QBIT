// ==========================================================================
//  QBIT -- Weather screen public API
// ==========================================================================
#ifndef WEATHER_SCREEN_H
#define WEATHER_SCREEN_H

#include <Arduino.h>

// Call when entering the WEATHER_SCREEN state.
// Checks 10-minute cache; fetches fresh data from Open-Meteo if stale,
// shows "Loading..." while fetching, then draws the full screen.
void weatherScreenEnter();

// Redraw the weather screen using cached data (called periodically by display task).
void weatherScreenDraw();

// Fetch weather data now and update cache.
// Returns true if fresh data was fetched successfully.
bool weatherScreenRefreshNow();

// Invalidate the cache so the next weatherScreenEnter() forces a fresh fetch.
void weatherScreenInvalidateCache();

#endif // WEATHER_SCREEN_H
