// ==========================================================================
//  QBIT -- Display utility functions
// ==========================================================================
#include "display_helpers.h"
#include "app_state.h"
#include "settings.h"
#include <Wire.h>

// ==========================================================================
//  Clear full GDDRAM via raw I2C
// ==========================================================================
void clearFullGDDRAM() {
    const uint8_t ADDR       = 0x3C;
    const uint8_t TOTAL_COLS = 132;
    const uint8_t CHUNK      = 16;

    Wire.beginTransmission(ADDR);
    Wire.write(0x00);
    Wire.write(0x20);
    Wire.write(0x02);  // page mode
    Wire.endTransmission();

    for (uint8_t page = 0; page < 8; page++) {
        Wire.beginTransmission(ADDR);
        Wire.write(0x00);
        Wire.write(0xB0 | page);
        Wire.write(0x00);
        Wire.write(0x10);
        Wire.endTransmission();

        for (uint8_t off = 0; off < TOTAL_COLS; off += CHUNK) {
            uint8_t len = TOTAL_COLS - off;
            if (len > CHUNK) len = CHUNK;
            Wire.beginTransmission(ADDR);
            Wire.write(0x40);
            for (uint8_t i = 0; i < len; i++) Wire.write((uint8_t)0x00);
            Wire.endTransmission();
        }
    }

    Wire.beginTransmission(ADDR);
    Wire.write(0x00);
    Wire.write(0x20);  Wire.write(0x00);                     // horizontal mode
    Wire.write(0x21);  Wire.write(0x00);  Wire.write(0x7F);  // col  0-127
    Wire.write(0x22);  Wire.write(0x00);  Wire.write(0x07);  // page 0-7
    Wire.endTransmission();
}

// ==========================================================================
//  Display brightness (SSD1306 contrast)
// ==========================================================================

void setDisplayBrightness(uint8_t val) {
    setDisplayBrightnessVal(val);  // store in settings
    Wire.beginTransmission(0x3C);
    Wire.write(0x00);
    Wire.write(0x81);
    Wire.write(val);
    Wire.endTransmission();
}

uint8_t getDisplayBrightness() {
    return getDisplayBrightnessVal();
}

// ==========================================================================
//  Display inversion
// ==========================================================================

void setDisplayInvert(bool invert) {
    Wire.beginTransmission(0x3C);
    Wire.write(0x00);
    Wire.write(invert ? 0xA7 : 0xA6);
    Wire.endTransmission();
}

// ==========================================================================
//  Rotate U8G2 buffer 180° in-place
// ==========================================================================

void rotateBuffer180() {
    uint8_t *buf = u8g2.getBufferPtr();
    const uint16_t len = 1024;

    for (uint16_t i = 0; i < len / 2; i++) {
        uint8_t tmp       = buf[i];
        buf[i]            = buf[len - 1 - i];
        buf[len - 1 - i]  = tmp;
    }

    for (uint16_t i = 0; i < len; i++) {
        uint8_t b = buf[i];
        b = ((b & 0xF0) >> 4) | ((b & 0x0F) << 4);
        b = ((b & 0xCC) >> 2) | ((b & 0x33) << 2);
        b = ((b & 0xAA) >> 1) | ((b & 0x55) << 1);
        buf[i] = b;
    }
}

// ==========================================================================
//  Show text (up to 4 lines)
// ==========================================================================

void showText(const char *l1, const char *l2,
              const char *l3, const char *l4) {
    u8g2.clearBuffer();
    u8g2.setFont(u8g2_font_6x13_tr);
    if (l1) u8g2.drawStr(4, 13, l1);
    if (l2) u8g2.drawStr(4, 28, l2);
    if (l3) u8g2.drawStr(4, 43, l3);
    if (l4) u8g2.drawStr(4, 58, l4);
    rotateBuffer180();
    u8g2.sendBuffer();
}
