// ==========================================================================
//  QBIT -- Poke rendering + history
// ==========================================================================
#ifndef POKE_HANDLER_H
#define POKE_HANDLER_H

#include <Arduino.h>
#include "app_state.h"

// Initialize poke handler state.
void pokeHandlerInit();

// Handle a text-only poke (shows sender + text on OLED).
void handlePoke(const char *sender, const char *text);

// Handle a bitmap poke (pre-rendered sender + text bitmaps).
void handlePokeBitmap(const char *sender, const char *text,
                      const char *senderBmp64, uint16_t senderW,
                      const char *textBmp64, uint16_t textW);

// Handle a bitmap poke from pre-decoded heap pointers (ownership transferred).
void handlePokeBitmapFromPtrs(const char *sender, const char *text,
                              uint8_t *senderBmp, uint16_t senderW, size_t senderLen,
                              uint8_t *textBmp, uint16_t textW, size_t textLen);

// Render the current bitmap poke frame (with scrolling).
void showPokeBitmap();

// Render a history record with bitmap data and a header line.
void showPokeHistoryBitmap(const PokeRecord *rec, const char *header, int16_t scrollX = 0);

// Free heap-allocated poke bitmap buffers.
void freePokeBitmaps();

// Advance scroll offset. Returns true if scroll is active.
bool pokeAdvanceScroll();

// Poke state queries
bool     pokeIsActive();
bool     pokeIsBitmapMode();
uint16_t pokeMaxWidth();
void     pokeSetActive(bool active);
unsigned long pokeStartMs();

// --- History ring buffer ---
void        pokeAddToHistory(const char *sender, const char *text, time_t timestamp);
void        pokeAddToHistoryWithBitmaps(const char *sender, const char *text, time_t timestamp,
                                        const uint8_t *sBmp, uint16_t sW, uint16_t sH,
                                        const uint8_t *tBmp, uint16_t tW, uint16_t tH);
PokeRecord* pokeGetHistory(uint8_t index);  // 0 = most recent
uint8_t     pokeHistoryCount();

// Decode base64 and allocate buffer. Returns nullptr on failure.
uint8_t* decodeBase64Alloc(const char *b64, size_t *outLen);

// Display times
#define POKE_DISPLAY_MS        5000
#define POKE_SCROLL_DISPLAY_MS 8000
#define POKE_SCROLL_INTERVAL_MS 30
#define POKE_SCROLL_PX          2

#endif // POKE_HANDLER_H
