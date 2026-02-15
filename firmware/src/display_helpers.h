// ==========================================================================
//  QBIT -- Display utility functions
// ==========================================================================
#ifndef DISPLAY_HELPERS_H
#define DISPLAY_HELPERS_H

#include <Arduino.h>

// Clear all GDDRAM including extra columns (SH1106 compat).
void clearFullGDDRAM();

// Set SSD1306 contrast (brightness 0-255) via raw I2C.
void setDisplayBrightness(uint8_t val);

// Get current brightness value.
uint8_t getDisplayBrightness();

// Toggle display inversion via I2C command.
void setDisplayInvert(bool invert);

// Rotate the U8G2 frame buffer 180 degrees in-place.
void rotateBuffer180();

// Show up to 4 lines of 6x13 text on the OLED (rotated 180°).
void showText(const char *l1, const char *l2 = nullptr,
              const char *l3 = nullptr, const char *l4 = nullptr);

#endif // DISPLAY_HELPERS_H
