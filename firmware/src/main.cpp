#include <Arduino.h>
#include <U8g2lib.h>
#include <Wire.h>

#include "daichi_gundam.h"
#include "daichi_intro.h"

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------
// Hardware I2C for fast buffer transfer; U8G2_R0 as base orientation.
// 180-degree rotation is applied in software during the frame transpose to
// avoid column-offset artifacts that some SSD1306 clones exhibit with U8G2_R2.
// SDA = GPIO20, SCL = GPIO21
U8G2_SSD1306_128X64_NONAME_F_HW_I2C u8g2(
    U8G2_R0, /* reset=*/U8X8_PIN_NONE, /* clock=*/21, /* data=*/20);

// Playback speed multiplier (2 = half delay, 4 = quarter delay, etc.)
#define GIF_SPEED 2

// ---------------------------------------------------------------------------
// clearFullGDDRAM -- wipe the entire display memory via raw I2C
// ---------------------------------------------------------------------------
// Many cheap "SSD1306" modules actually carry an SH1106-compatible controller
// whose GDDRAM is 132 columns wide.  U8g2's SSD1306 driver only writes
// columns 0-127, so columns 128-131 retain power-on garbage and can show up
// as a persistent white line along one edge.  Writing 132 zero-bytes per page
// in page-addressing mode clears everything; on a genuine 128-column SSD1306
// the extra writes are silently ignored.
void clearFullGDDRAM() {
  const uint8_t ADDR = 0x3C;
  const uint8_t TOTAL_COLS = 132;
  const uint8_t CHUNK = 16;

  // Enter page-addressing mode
  Wire.beginTransmission(ADDR);
  Wire.write(0x00);            // command stream
  Wire.write(0x20);            // Set Memory Addressing Mode
  Wire.write(0x02);            // page mode
  Wire.endTransmission();

  // Zero every page
  for (uint8_t page = 0; page < 8; page++) {
    Wire.beginTransmission(ADDR);
    Wire.write(0x00);          // command stream
    Wire.write(0xB0 | page);  // page address
    Wire.write(0x00);          // column lower nibble = 0
    Wire.write(0x10);          // column upper nibble = 0
    Wire.endTransmission();

    for (uint8_t off = 0; off < TOTAL_COLS; off += CHUNK) {
      uint8_t len = TOTAL_COLS - off;
      if (len > CHUNK) len = CHUNK;
      Wire.beginTransmission(ADDR);
      Wire.write(0x40);       // data stream
      for (uint8_t i = 0; i < len; i++) Wire.write((uint8_t)0x00);
      Wire.endTransmission();
    }
  }

  // Restore horizontal-addressing mode for U8g2 sendBuffer()
  Wire.beginTransmission(ADDR);
  Wire.write(0x00);            // command stream
  Wire.write(0x20);  Wire.write(0x00);   // horizontal mode
  Wire.write(0x21);  Wire.write(0x00);  Wire.write(0x7F);  // col 0-127
  Wire.write(0x22);  Wire.write(0x00);  Wire.write(0x07);  // page 0-7
  Wire.endTransmission();
}

// ---------------------------------------------------------------------------
// playGIF -- render an AnimatedGIF to the display
// ---------------------------------------------------------------------------
// Converts the horizontal-bit GIF frame data into the SSD1306 vertical-page
// buffer format in a single pass, applying colour inversion and 180-degree
// rotation via an 8x8 bit-block transpose.
void playGIF(const AnimatedGIF *gif, uint16_t loopCount = 1) {
  uint8_t *buf            = u8g2.getBufferPtr();
  const uint16_t bpr      = (gif->width + 7) / 8;   // bytes per row
  const uint8_t  pages    = gif->height / 8;

  for (uint16_t loop = 0; loop < loopCount; loop++) {
    for (uint8_t frame = 0; frame < gif->frame_count; frame++) {
      const uint8_t *src = gif->frames[frame];

      // --- 8x8 block transpose with inversion + 180-deg rotation ----------
      // Rotation is achieved by reversing page, byte-column, row-bit, and
      // column-bit order simultaneously during the transpose.
      for (uint8_t sp = 0; sp < pages; sp++) {
        uint8_t dp = pages - 1 - sp;
        for (uint8_t sbc = 0; sbc < bpr; sbc++) {
          uint8_t dbc = bpr - 1 - sbc;

          // Read & invert 8 source rows for this block
          uint8_t r[8];
          for (uint8_t row = 0; row < 8; row++)
            r[row] = ~pgm_read_byte(&src[(sp * 8 + row) * bpr + sbc]);

          // Transpose into vertical-page bytes (unrolled for speed)
          uint16_t base = dp * 128 + dbc * 8;
          for (uint8_t col = 0; col < 8; col++) {
            uint8_t m = 0x80 >> col;
            uint8_t v = 0;
            if (r[0] & m) v |= 0x80;
            if (r[1] & m) v |= 0x40;
            if (r[2] & m) v |= 0x20;
            if (r[3] & m) v |= 0x10;
            if (r[4] & m) v |= 0x08;
            if (r[5] & m) v |= 0x04;
            if (r[6] & m) v |= 0x02;
            if (r[7] & m) v |= 0x01;
            buf[base + 7 - col] = v;
          }
        }
      }

      // Black out the leftmost column (source x=127 padding artifact)
      for (uint8_t p = 0; p < pages; p++) buf[p * 128] = 0x00;

      u8g2.sendBuffer();

      uint16_t d = gif->delays[frame] / GIF_SPEED;
      delay(d > 0 ? d : 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Arduino entry points
// ---------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  u8g2.setBusClock(400000);
  u8g2.begin();
  clearFullGDDRAM();
  u8g2.clearBuffer();
  u8g2.sendBuffer();
}

void loop() {
  playGIF(&daichi_intro_gif, 1);
}
