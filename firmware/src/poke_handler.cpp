// ==========================================================================
//  QBIT -- Poke rendering + history
// ==========================================================================
#include "poke_handler.h"
#include "app_state.h"
#include "display_helpers.h"
#include "time_manager.h"
#include "mbedtls/base64.h"

// ==========================================================================
//  Internal state
// ==========================================================================

static bool          _pokeActive  = false;
static unsigned long _pokeStartMs = 0;

// Bitmap poke data
static uint8_t *_pokeSenderBmp    = nullptr;
static uint16_t _pokeSenderWidth  = 0;
static uint16_t _pokeSenderHeight = 0;
static uint8_t *_pokeTextBmp      = nullptr;
static uint16_t _pokeTextWidth    = 0;
static uint16_t _pokeTextHeight   = 0;
static bool     _pokeBitmapMode   = false;
static int16_t  _pokeScrollOffset = 0;
static unsigned long _pokeLastScrollMs = 0;

// History ring buffer (3 entries)
#define POKE_HISTORY_SIZE 3
static PokeRecord _pokeHistory[POKE_HISTORY_SIZE];
static uint8_t    _pokeHistoryCount = 0;
static uint8_t    _pokeHistoryHead  = 0;

// ==========================================================================
//  Init
// ==========================================================================

void pokeHandlerInit() {
    _pokeActive = false;
    _pokeBitmapMode = false;
    _pokeHistoryCount = 0;
    _pokeHistoryHead = 0;
}

// ==========================================================================
//  State queries
// ==========================================================================

bool     pokeIsActive()     { return _pokeActive; }
bool     pokeIsBitmapMode() { return _pokeBitmapMode; }
void     pokeSetActive(bool active) { _pokeActive = active; }
unsigned long pokeStartMs() { return _pokeStartMs; }

uint16_t pokeMaxWidth() {
    return max(_pokeSenderWidth, _pokeTextWidth);
}

// ==========================================================================
//  Base64 decode helper
// ==========================================================================

uint8_t* decodeBase64Alloc(const char *b64, size_t *outLen) {
    size_t b64Len = strlen(b64);
    size_t maxOut = (b64Len * 3) / 4 + 4;
    uint8_t *buf = (uint8_t *)malloc(maxOut);
    if (!buf) return nullptr;

    size_t actualLen = 0;
    int ret = mbedtls_base64_decode(buf, maxOut, &actualLen,
                                     (const unsigned char *)b64, b64Len);
    if (ret != 0) {
        free(buf);
        return nullptr;
    }
    *outLen = actualLen;
    return buf;
}

// ==========================================================================
//  Free bitmap buffers
// ==========================================================================

void freePokeBitmaps() {
    if (_pokeSenderBmp) { free(_pokeSenderBmp); _pokeSenderBmp = nullptr; }
    if (_pokeTextBmp)   { free(_pokeTextBmp);   _pokeTextBmp   = nullptr; }
    _pokeSenderWidth  = 0;
    _pokeSenderHeight = 0;
    _pokeTextWidth    = 0;
    _pokeTextHeight   = 0;
    _pokeBitmapMode   = false;
}

// ==========================================================================
//  Draw bitmap to U8G2 buffer (with circular scroll support)
// ==========================================================================

static void drawBitmapToBuffer(const uint8_t *bmpData, uint16_t bmpWidth,
                               uint16_t bmpHeight, int16_t yOffset, int16_t scrollX) {
    uint8_t *buf = u8g2.getBufferPtr();
    uint8_t bmpPages = (bmpHeight + 7) / 8;
    // For wide bitmaps: circular wrap with a 64px gap between repeats
    bool wrap = (bmpWidth > 128);
    uint16_t virtualWidth = wrap ? (bmpWidth + 64) : bmpWidth;

    for (int16_t screenX = 0; screenX < 128; screenX++) {
        int16_t srcX = screenX + scrollX;
        if (wrap) {
            srcX = ((srcX % (int16_t)virtualWidth) + virtualWidth) % virtualWidth;
            // If srcX falls in the gap region, skip (blank)
            if (srcX >= (int16_t)bmpWidth) continue;
        }
        if (srcX < 0 || srcX >= (int16_t)bmpWidth) continue;

        for (uint8_t bmpPage = 0; bmpPage < bmpPages; bmpPage++) {
            uint8_t srcByte = bmpData[bmpPage * bmpWidth + srcX];
            if (srcByte == 0) continue;

            for (uint8_t bit = 0; bit < 8; bit++) {
                if (srcByte & (1 << bit)) {
                    int16_t pixelY = yOffset + bmpPage * 8 + bit;
                    if (pixelY < 0 || pixelY >= 64) continue;

                    uint8_t targetPage = pixelY / 8;
                    uint8_t targetBit  = pixelY % 8;
                    buf[targetPage * 128 + screenX] |= (1 << targetBit);
                }
            }
        }
    }
}

// ==========================================================================
//  Show the bitmap poke frame
// ==========================================================================

void showPokeBitmap() {
    u8g2.clearBuffer();

    // Row 1: ">> Poke! <<" header
    u8g2.setFont(u8g2_font_6x13_tr);
    u8g2.drawStr(4, 13, ">> Poke! <<");

    // Row 2: sender name bitmap
    const int16_t senderY = 15;
    uint16_t senderH = _pokeSenderHeight > 0 ? _pokeSenderHeight : 16;
    if (_pokeSenderBmp && _pokeSenderWidth > 0) {
        int16_t senderScroll = 0;
        if (_pokeSenderWidth > 128) {
            senderScroll = _pokeScrollOffset;
        }
        drawBitmapToBuffer(_pokeSenderBmp, _pokeSenderWidth, senderH, senderY, senderScroll);
    }

    // Row 3-4: message text bitmap
    const int16_t textY = senderY + senderH + 1;
    uint16_t textH = _pokeTextHeight > 0 ? _pokeTextHeight : 16;
    if (_pokeTextBmp && _pokeTextWidth > 0) {
        int16_t textScroll = 0;
        if (_pokeTextWidth > 128) {
            textScroll = _pokeScrollOffset;
        }
        drawBitmapToBuffer(_pokeTextBmp, _pokeTextWidth, textH, textY, textScroll);
    }

    rotateBuffer180();
    u8g2.sendBuffer();
}

// ==========================================================================
//  Advance scroll (called from display task tick)
// ==========================================================================

bool pokeAdvanceScroll() {
    unsigned long now = millis();
    if (now - _pokeLastScrollMs < POKE_SCROLL_INTERVAL_MS) return false;
    _pokeLastScrollMs = now;

    uint16_t maxWidth = pokeMaxWidth();
    if (maxWidth <= 128) return false;

    // Circular scroll — no reset, just keep incrementing
    _pokeScrollOffset += POKE_SCROLL_PX;
    // Wrap around at virtualWidth (bmpWidth + 64px gap)
    uint16_t virtualWidth = maxWidth + 64;
    if (_pokeScrollOffset >= (int16_t)virtualWidth) {
        _pokeScrollOffset -= (int16_t)virtualWidth;
    }

    showPokeBitmap();
    return true;
}

// ==========================================================================
//  Render a history record's bitmaps with a header line
// ==========================================================================

void showPokeHistoryBitmap(const PokeRecord *rec, const char *header, int16_t scrollX) {
    u8g2.clearBuffer();

    // Row 1: header (timestamp)
    u8g2.setFont(u8g2_font_6x13_tr);
    u8g2.drawStr(4, 13, header);

    // Row 2: sender bitmap (only scroll if wider than 128)
    const int16_t senderY = 15;
    uint16_t senderH = rec->senderBmpH > 0 ? rec->senderBmpH : 16;
    if (rec->senderBmp && rec->senderBmpW > 0) {
        int16_t senderScroll = (rec->senderBmpW > 128) ? scrollX : 0;
        drawBitmapToBuffer(rec->senderBmp, rec->senderBmpW, senderH, senderY, senderScroll);
    }

    // Row 3-4: text bitmap (only scroll if wider than 128)
    const int16_t textY = senderY + senderH + 1;
    uint16_t textH = rec->textBmpH > 0 ? rec->textBmpH : 16;
    if (rec->textBmp && rec->textBmpW > 0) {
        int16_t textScroll = (rec->textBmpW > 128) ? scrollX : 0;
        drawBitmapToBuffer(rec->textBmp, rec->textBmpW, textH, textY, textScroll);
    }

    rotateBuffer180();
    u8g2.sendBuffer();
}

// ==========================================================================
//  Handle text-only poke
// ==========================================================================

void handlePoke(const char *sender, const char *text) {
    freePokeBitmaps();
    _pokeActive  = true;
    _pokeStartMs = millis();
    _pokeScrollOffset = 0;
    _pokeLastScrollMs = millis();

    showText(">> Poke! <<", "", sender, text);

    // Add to history
    pokeAddToHistory(sender, text, timeManagerNow());

    Serial.printf("Poke from %s: %s\n", sender, text);
}

// ==========================================================================
//  Handle bitmap poke
// ==========================================================================

void handlePokeBitmap(const char *sender, const char *text,
                      const char *senderBmp64, uint16_t senderW,
                      const char *textBmp64, uint16_t textW) {
    freePokeBitmaps();

    // Decode sender bitmap
    size_t senderLen = 0;
    _pokeSenderBmp = decodeBase64Alloc(senderBmp64, &senderLen);
    if (_pokeSenderBmp != nullptr && senderW > 0) {
        _pokeSenderWidth  = senderW;
        _pokeSenderHeight = (senderLen / senderW) * 8;
    }

    // Decode text bitmap
    size_t textLen = 0;
    _pokeTextBmp = decodeBase64Alloc(textBmp64, &textLen);
    if (_pokeTextBmp != nullptr && textW > 0) {
        _pokeTextWidth  = textW;
        _pokeTextHeight = (textLen / textW) * 8;
    }

    _pokeBitmapMode  = true;
    _pokeActive      = true;
    _pokeStartMs     = millis();
    _pokeScrollOffset = 0;
    _pokeLastScrollMs = millis();

    showPokeBitmap();

    // Add to history with bitmap copies
    pokeAddToHistoryWithBitmaps(sender, text, timeManagerNow(),
        _pokeSenderBmp, _pokeSenderWidth, _pokeSenderHeight,
        _pokeTextBmp, _pokeTextWidth, _pokeTextHeight);

    Serial.printf("Bitmap poke from %s: %s\n", sender, text);
}

// ==========================================================================
//  Handle bitmap poke from pre-decoded pointers (ownership transferred)
// ==========================================================================

void handlePokeBitmapFromPtrs(const char *sender, const char *text,
                              uint8_t *senderBmp, uint16_t senderW, size_t senderLen,
                              uint8_t *textBmp, uint16_t textW, size_t textLen) {
    freePokeBitmaps();

    _pokeSenderBmp = senderBmp;
    if (_pokeSenderBmp && senderW > 0) {
        _pokeSenderWidth  = senderW;
        _pokeSenderHeight = (senderLen / senderW) * 8;
    }

    _pokeTextBmp = textBmp;
    if (_pokeTextBmp && textW > 0) {
        _pokeTextWidth  = textW;
        _pokeTextHeight = (textLen / textW) * 8;
    }

    _pokeBitmapMode  = true;
    _pokeActive      = true;
    _pokeStartMs     = millis();
    _pokeScrollOffset = 0;
    _pokeLastScrollMs = millis();

    showPokeBitmap();

    // Add to history with bitmap copies
    pokeAddToHistoryWithBitmaps(sender, text, timeManagerNow(),
        _pokeSenderBmp, _pokeSenderWidth, _pokeSenderHeight,
        _pokeTextBmp, _pokeTextWidth, _pokeTextHeight);

    Serial.printf("Bitmap poke (ptrs) from %s: %s\n", sender, text);
}

// ==========================================================================
//  History ring buffer
// ==========================================================================

void pokeAddToHistory(const char *sender, const char *text, time_t timestamp) {
    PokeRecord &rec = _pokeHistory[_pokeHistoryHead];
    rec.freeBitmaps();  // free previous bitmap data if any
    rec.sender    = String(sender);
    rec.text      = String(text);
    rec.timestamp = timestamp;
    rec.hasBitmaps = false;

    _pokeHistoryHead = (_pokeHistoryHead + 1) % POKE_HISTORY_SIZE;
    if (_pokeHistoryCount < POKE_HISTORY_SIZE) {
        _pokeHistoryCount++;
    }
}

void pokeAddToHistoryWithBitmaps(const char *sender, const char *text, time_t timestamp,
                                  const uint8_t *sBmp, uint16_t sW, uint16_t sH,
                                  const uint8_t *tBmp, uint16_t tW, uint16_t tH) {
    PokeRecord &rec = _pokeHistory[_pokeHistoryHead];
    rec.freeBitmaps();  // free previous bitmap data if any
    rec.sender    = String(sender);
    rec.text      = String(text);
    rec.timestamp = timestamp;

    // Copy sender bitmap
    if (sBmp && sW > 0 && sH > 0) {
        size_t sSize = (size_t)(sH / 8) * sW;
        if (sSize == 0) sSize = sW;  // at least 1 page
        rec.senderBmp = (uint8_t *)malloc(sSize);
        if (rec.senderBmp) {
            memcpy(rec.senderBmp, sBmp, sSize);
            rec.senderBmpW = sW;
            rec.senderBmpH = sH;
        }
    }

    // Copy text bitmap
    if (tBmp && tW > 0 && tH > 0) {
        size_t tSize = (size_t)(tH / 8) * tW;
        if (tSize == 0) tSize = tW;
        rec.textBmp = (uint8_t *)malloc(tSize);
        if (rec.textBmp) {
            memcpy(rec.textBmp, tBmp, tSize);
            rec.textBmpW = tW;
            rec.textBmpH = tH;
        }
    }

    rec.hasBitmaps = (rec.senderBmp != nullptr || rec.textBmp != nullptr);

    _pokeHistoryHead = (_pokeHistoryHead + 1) % POKE_HISTORY_SIZE;
    if (_pokeHistoryCount < POKE_HISTORY_SIZE) {
        _pokeHistoryCount++;
    }
}

PokeRecord* pokeGetHistory(uint8_t index) {
    if (index >= _pokeHistoryCount) return nullptr;

    // index 0 = most recent
    int pos = (int)_pokeHistoryHead - 1 - (int)index;
    if (pos < 0) pos += POKE_HISTORY_SIZE;
    return &_pokeHistory[pos];
}

uint8_t pokeHistoryCount() {
    return _pokeHistoryCount;
}
