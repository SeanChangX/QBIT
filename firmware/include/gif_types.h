#ifndef GIF_TYPES_H
#define GIF_TYPES_H

#include <stdint.h>

// ---------------------------------------------------------------------------
// AnimatedGIF -- shared struct for PROGMEM boot animation data
// ---------------------------------------------------------------------------
// Guard matches the one used by gif2cpp-generated headers (sys_scx.h, etc.)
// so only one definition is active regardless of include order.
#ifndef ANIMATED_GIF_DEFINED
#define ANIMATED_GIF_DEFINED
typedef struct {
  const uint8_t  frame_count;
  const uint16_t width;
  const uint16_t height;
  const uint16_t *delays;
  const uint8_t  (*frames)[1024];
} AnimatedGIF;
#endif // ANIMATED_GIF_DEFINED

// ---------------------------------------------------------------------------
// .qgif binary format constants
// ---------------------------------------------------------------------------
// Layout:
//   [0]       uint8_t   frame_count
//   [1..2]    uint16_t  width   (LE)
//   [3..4]    uint16_t  height  (LE)
//   [5..]     uint16_t  delays[frame_count]  (LE)
//   [..]      uint8_t   frames[frame_count][QGIF_FRAME_SIZE]
//
#define QGIF_HEADER_SIZE   5
#define QGIF_MAX_FRAMES    255
#define QGIF_FRAME_WIDTH   128
#define QGIF_FRAME_HEIGHT  64
#define QGIF_FRAME_SIZE    ((QGIF_FRAME_WIDTH / 8) * QGIF_FRAME_HEIGHT)  // 1024

#endif // GIF_TYPES_H
