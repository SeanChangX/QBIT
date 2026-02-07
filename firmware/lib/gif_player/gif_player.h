#ifndef GIF_PLAYER_H
#define GIF_PLAYER_H

#include <Arduino.h>
#include <U8g2lib.h>
#include "gif_types.h"

// Mount LittleFS and store the display pointer for rendering.
bool gifPlayerInit(U8G2 *display);

// Return true if at least one .qgif file exists on LittleFS.
bool gifPlayerHasFiles();

// Return the filename of the first .qgif file found (empty if none).
String gifPlayerGetFirstFile();

// Return the filename after 'current' in alphabetical order (wraps around).
// If current is empty or not found, returns the first file.
String gifPlayerGetNextFile(const String &current);

// Build (or rebuild) the internal shuffle bag by scanning LittleFS for
// .qgif files and applying a Fisher-Yates shuffle.  Call once after init
// and again whenever files are added/removed.
void gifPlayerBuildShuffleBag();

// Return the next filename from the shuffle bag.  When the bag is
// exhausted it is automatically reshuffled (the last-played file is kept
// away from position 0 to avoid immediate repeats at the boundary).
String gifPlayerNextShuffle();

// Enable auto-advance: after each GIF has looped 'loopsPerGif' times the
// player automatically switches to the next file from the shuffle bag.
// Pass 0 to disable auto-advance (default).
void gifPlayerSetAutoAdvance(uint8_t loopsPerGif);

// Request a file change (takes effect on next tick).
// Pass an empty string to stop playback.
void gifPlayerSetFile(const String &filename);

// Return the filename currently being played (empty if idle).
String gifPlayerGetCurrentFile();

// Set playback speed divisor (1 = normal, 2 = 2x, etc.).
void gifPlayerSetSpeed(uint16_t divisor);

// Return the current playback speed divisor.
uint16_t gifPlayerGetSpeed();

// Non-blocking tick -- call from loop().
// Renders the next frame when timing is due.
void gifPlayerTick();

// Render a raw 128x64 monochrome bitmap to the display.
// Applies 8x8 block transpose with colour inversion and 180-degree rotation
// to match the SSD1306 page-column memory layout.
// Shared by both the PROGMEM boot animation and file-based playback.
void gifRenderFrame(U8G2 *display, const uint8_t *frameData,
                    uint16_t width, uint16_t height);

#endif // GIF_PLAYER_H
