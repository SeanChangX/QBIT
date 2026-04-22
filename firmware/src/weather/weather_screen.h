// ==========================================================================
//  QBIT -- Weather screen public API
// ==========================================================================
#ifndef WEATHER_SCREEN_H
#define WEATHER_SCREEN_H

#include <Arduino.h>

// Call when entering the WEATHER_SCREEN state.
// Uses a 1-hour cache; fetches fresh data from Open-Meteo if stale,
// shows "Loading..." while fetching, then draws the full screen.
void weatherScreenEnter();

// Call from the display task while staying on WEATHER_SCREEN: refreshes in the
// background when cache is older than one hour (same interval as enter()).
void weatherScreenIdleTick();

// Redraw the weather screen from cache (after enter/fetch or web save refresh).
void weatherScreenDraw();

// Fetch weather data now and update cache.
// Returns true if fresh data was fetched successfully.
bool weatherScreenRefreshNow();

// Drop cached readings (e.g. after setWeatherLocation from NVS).
void weatherScreenInvalidateCache();

#endif // WEATHER_SCREEN_H
