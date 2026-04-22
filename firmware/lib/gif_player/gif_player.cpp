#include "gif_player.h"
#include <LittleFS.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

// Forward declarations -- defined in settings.cpp
extern bool getFlipMode();
extern bool getNegativeGif();

extern SemaphoreHandle_t gifPlayerMutex;

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------
static U8G2         *_display       = nullptr;
static File          _file;
static bool          _playing       = false;
static uint8_t       _frameCount    = 0;
static uint16_t      _width         = 0;
static uint16_t      _height        = 0;
static uint16_t      _delays[QGIF_MAX_FRAMES];
static uint8_t       _frameBuf[QGIF_FRAME_SIZE];
static uint8_t       _currentFrame  = 0;
static unsigned long _lastFrameMs   = 0;
static uint32_t      _dataOffset    = 0;   // byte offset to first frame in file
static String        _currentFile;
static String        _requestedFile;
static bool          _fileChanged   = false;
static uint16_t      _speedDivisor  = 1;

// --- Shuffle bag (fair random) ---
static String        _shuffleBag[QGIF_MAX_FRAMES];
static uint8_t       _shuffleTotal  = 0;   // number of files in the bag
static uint8_t       _shufflePos    = 0;   // next index to hand out

// --- Auto-advance ---
static uint8_t       _loopCount     = 0;
static uint8_t       _loopsPerGif   = 0;   // 0 = disabled

// --- Idle animation (PROGMEM, played between GIFs) ---
static const AnimatedGIF *_idleAnim        = nullptr;
static bool               _idlePlaying     = false;
static uint8_t            _idleFrame       = 0;
static unsigned long      _idleLastFrameMs = 0;
static uint8_t            _idleFrameBuf[QGIF_FRAME_SIZE];
static uint8_t            _idleLoopCount   = 0;
static uint8_t            _idleLoopTarget  = 1;

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

// Open a .qgif file, parse header + delays, prepare for frame streaming.
static bool _openFile(const String &filename) {
  if (_file) _file.close();
  _playing = false;

  String path = "/" + filename;
  _file = LittleFS.open(path, "r");
  if (!_file) {
    Serial.println("gifPlayer: cannot open " + path);
    return false;
  }

  // --- Read 5-byte header ---
  uint8_t hdr[QGIF_HEADER_SIZE];
  if (_file.read(hdr, QGIF_HEADER_SIZE) != QGIF_HEADER_SIZE) {
    _file.close();
    return false;
  }

  _frameCount = hdr[0];
  _width      = hdr[1] | ((uint16_t)hdr[2] << 8);
  _height     = hdr[3] | ((uint16_t)hdr[4] << 8);

  if (_frameCount == 0 || _width != QGIF_FRAME_WIDTH ||
      _height != QGIF_FRAME_HEIGHT) {
    Serial.printf("gifPlayer: bad header fc=%u w=%u h=%u\n",
                  _frameCount, _width, _height);
    _file.close();
    return false;
  }

  // --- Read delays array ---
  uint16_t delayBytes = (uint16_t)_frameCount * 2;
  uint8_t  delayBuf[QGIF_MAX_FRAMES * 2];
  if (_file.read(delayBuf, delayBytes) != delayBytes) {
    _file.close();
    return false;
  }
  for (uint8_t i = 0; i < _frameCount; i++) {
    _delays[i] = delayBuf[i * 2] | ((uint16_t)delayBuf[i * 2 + 1] << 8);
  }

  _dataOffset   = QGIF_HEADER_SIZE + delayBytes;
  _currentFrame = 0;
  _lastFrameMs  = 0;  // render first frame immediately
  _loopCount    = 0;
  _currentFile  = filename;
  _playing      = true;
  return true;
}

// Read one frame into _frameBuf by seeking to its offset.
static bool _readFrame(uint8_t idx) {
  uint32_t off = _dataOffset + (uint32_t)idx * QGIF_FRAME_SIZE;
  if (!_file.seek(off)) return false;
  return _file.read(_frameBuf, QGIF_FRAME_SIZE) == QGIF_FRAME_SIZE;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

bool gifPlayerInit(U8G2 *display) {
  _display = display;
  if (!LittleFS.begin(true /* formatOnFail */)) {
    Serial.println("gifPlayer: LittleFS mount failed");
    return false;
  }
  Serial.println("gifPlayer: LittleFS mounted");
  return true;
}

bool gifPlayerHasFiles() {
  File root = LittleFS.open("/");
  if (!root || !root.isDirectory()) return false;
  File f = root.openNextFile();
  while (f) {
    String name = String(f.name());
    f.close();
    if (name.endsWith(".qgif")) { root.close(); return true; }
    f = root.openNextFile();
  }
  root.close();
  return false;
}

String gifPlayerGetFirstFile() {
  File root = LittleFS.open("/");
  if (!root || !root.isDirectory()) return "";
  File f = root.openNextFile();
  while (f) {
    String name = String(f.name());
    f.close();
    if (name.endsWith(".qgif")) {
      if (name.startsWith("/")) name = name.substring(1);
      root.close();
      return name;
    }
    f = root.openNextFile();
  }
  root.close();
  return "";
}

String gifPlayerGetNextFile(const String &current) {
  File root = LittleFS.open("/");
  if (!root || !root.isDirectory()) return "";

  // Collect all .qgif filenames
  String files[QGIF_MAX_FRAMES];  // reuse max as upper bound
  uint8_t count = 0;
  File f = root.openNextFile();
  while (f && count < QGIF_MAX_FRAMES) {
    String name = String(f.name());
    f.close();
    if (name.endsWith(".qgif")) {
      if (name.startsWith("/")) name = name.substring(1);
      files[count++] = name;
    }
    f = root.openNextFile();
  }
  root.close();

  if (count == 0) return "";
  if (count == 1) return files[0];

  // Find current index, return next (wrap around)
  for (uint8_t i = 0; i < count; i++) {
    if (files[i] == current) {
      return files[(i + 1) % count];
    }
  }
  return files[0];  // current not found, return first
}

// ---------------------------------------------------------------------------
// Shuffle bag -- Fisher-Yates for fair random without immediate repeats
// ---------------------------------------------------------------------------

void gifPlayerBuildShuffleBag() {
  File root = LittleFS.open("/");
  if (!root || !root.isDirectory()) { _shuffleTotal = 0; return; }

  _shuffleTotal = 0;
  File f = root.openNextFile();
  while (f && _shuffleTotal < QGIF_MAX_FRAMES) {
    String name = String(f.name());
    f.close();
    if (name.endsWith(".qgif")) {
      if (name.startsWith("/")) name = name.substring(1);
      _shuffleBag[_shuffleTotal++] = name;
    }
    f = root.openNextFile();
  }
  root.close();

  // Fisher-Yates shuffle
  for (int i = (int)_shuffleTotal - 1; i > 0; i--) {
    uint8_t j = random(i + 1);
    String tmp      = _shuffleBag[i];
    _shuffleBag[i]  = _shuffleBag[j];
    _shuffleBag[j]  = tmp;
  }
  _shufflePos = 0;
}

String gifPlayerNextShuffle() {
  if (_shuffleTotal == 0) return "";
  if (_shuffleTotal == 1) return _shuffleBag[0];

  if (_shufflePos >= _shuffleTotal) {
    // Remember the last file handed out so we can avoid repeating it
    // at the boundary between two shuffles.
    String last = _shuffleBag[_shuffleTotal - 1];

    gifPlayerBuildShuffleBag();
    if (_shuffleTotal == 0) return "";

    // If the new bag starts with the same file that ended the old bag,
    // swap it to a random other position.
    if (_shuffleBag[0] == last && _shuffleTotal > 1) {
      uint8_t sw = 1 + random(_shuffleTotal - 1);
      _shuffleBag[0]  = _shuffleBag[sw];
      _shuffleBag[sw] = last;
    }
  }

  return _shuffleBag[_shufflePos++];
}

void gifPlayerSetAutoAdvance(uint8_t loopsPerGif) {
  _loopsPerGif = loopsPerGif;
}

void gifPlayerSetIdleAnimation(const AnimatedGIF *idle) {
  _idleAnim = idle;
}

void gifPlayerStartIdleIfNoUserGifs() {
  if (!_display || !_idleAnim) return;
  if (gifPlayerHasFiles()) return;

  if (gifPlayerMutex) xSemaphoreTake(gifPlayerMutex, portMAX_DELAY);
  if (_file) {
    _file.close();
  }
  _playing         = false;
  _fileChanged     = false;
  _requestedFile   = "";
  _currentFile     = "";
  _idlePlaying     = true;
  _idleFrame       = 0;
  _idleLoopCount   = 0;
  _idleLoopTarget  = 1 + (esp_random() % 5);
  _idleLastFrameMs = 0;
  if (gifPlayerMutex) xSemaphoreGive(gifPlayerMutex);
}

void gifPlayerSetFile(const String &filename) {
  if (gifPlayerMutex) xSemaphoreTake(gifPlayerMutex, portMAX_DELAY);
  _requestedFile = filename;
  _fileChanged   = true;
  if (gifPlayerMutex) xSemaphoreGive(gifPlayerMutex);
}

String gifPlayerGetCurrentFile() {
  if (gifPlayerMutex) xSemaphoreTake(gifPlayerMutex, portMAX_DELAY);
  String f = _currentFile;
  if (gifPlayerMutex) xSemaphoreGive(gifPlayerMutex);
  return f;
}

void gifPlayerSetSpeed(uint16_t divisor) {
  if (gifPlayerMutex) xSemaphoreTake(gifPlayerMutex, portMAX_DELAY);
  _speedDivisor = (divisor > 0) ? divisor : 1;
  if (gifPlayerMutex) xSemaphoreGive(gifPlayerMutex);
}

uint16_t gifPlayerGetSpeed() {
  if (gifPlayerMutex) xSemaphoreTake(gifPlayerMutex, portMAX_DELAY);
  uint16_t s = _speedDivisor;
  if (gifPlayerMutex) xSemaphoreGive(gifPlayerMutex);
  return s;
}

void gifPlayerTick() {
  if (!_display) return;

  // --- Idle animation playback (PROGMEM, between GIFs) ---
  if (_idlePlaying && _idleAnim) {
    // If a file change was requested externally (e.g. touch), interrupt
    // the idle animation and fall through to the file-change handler.
    if (_fileChanged) {
      _idlePlaying  = false;
      _idleFrame    = 0;
      _idleLoopCount = 0;
    } else {
      uint16_t delayMs = _idleAnim->delays[_idleFrame] / _speedDivisor;
      if (delayMs < 1) delayMs = 1;
      if (millis() - _idleLastFrameMs < delayMs) return;

      memcpy_P(_idleFrameBuf, _idleAnim->frames[_idleFrame], QGIF_FRAME_SIZE);
      gifRenderFrame(_display, _idleFrameBuf, _idleAnim->width, _idleAnim->height);

      _idleLastFrameMs = millis();
      _idleFrame++;
      if (_idleFrame >= _idleAnim->frame_count) {
        _idleFrame = 0;
        _idleLoopCount++;
        if (_idleLoopCount >= _idleLoopTarget) {
          // Idle loops done -- switch to next GIF (or keep idling if there are no .qgif files)
          _idlePlaying   = false;
          _idleLoopCount = 0;
          String next = gifPlayerNextShuffle();
          if (next.length() > 0) {
            _requestedFile = next;
            _fileChanged   = true;
          } else if (_idleAnim) {
            _idlePlaying     = true;
            _idleFrame       = 0;
            _idleLoopCount   = 0;
            _idleLoopTarget  = 1 + (esp_random() % 5);
            _idleLastFrameMs = 0;
          }
        }
      }
      return;  // don't process normal GIF while idle is playing
    }
  }

  // --- Handle pending file-change request ---
  if (_fileChanged) {
    _fileChanged = false;
    if (_requestedFile.length() > 0) {
      _openFile(_requestedFile);
    } else {
      if (_file) _file.close();
      _playing     = false;
      _currentFile = "";
    }
  }

  if (!_playing) return;

  // --- Frame timing ---
  uint16_t delayMs = _delays[_currentFrame] / _speedDivisor;
  if (delayMs < 1) delayMs = 1;
  if (millis() - _lastFrameMs < delayMs) return;

  // --- Read frame from flash and render ---
  if (_readFrame(_currentFrame)) {
    gifRenderFrame(_display, _frameBuf, _width, _height);
  }

  _lastFrameMs = millis();
  _currentFrame++;
  if (_currentFrame >= _frameCount) {
    _currentFrame = 0;
    _loopCount++;

    // Auto-advance to next shuffled GIF after N full loops
    if (_loopsPerGif > 0 && _loopCount >= _loopsPerGif) {
      _loopCount = 0;

      // If idle animation is configured, play it before the next GIF
      if (_idleAnim) {
        _idlePlaying     = true;
        _idleFrame       = 0;
        _idleLoopCount   = 0;
        _idleLoopTarget  = 1 + (esp_random() % 5);  // 1..5 random loops
        _idleLastFrameMs = 0;  // render first frame immediately
      } else {
        // No idle animation, advance directly
        String next = gifPlayerNextShuffle();
        if (next.length() > 0) {
          _requestedFile = next;
          _fileChanged   = true;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// gifRenderFrame -- rotation-aware render via U8G2 drawBitmap
// ---------------------------------------------------------------------------
// qgif stores 0=lit, 1=dark. U8G2 drawBitmap draws bit=1 as foreground.
// Invert frameData in-place when needed (caller's buffer; do not reuse before refill).
// Default U8G2_R0: apply 180 deg buffer rotation only when flip mode is on.
void gifRenderFrame(U8G2 *display, uint8_t *frameData,
                    uint16_t width, uint16_t height) {
  // Invert polarity unless Negative GIF mode is on
  if (!getNegativeGif()) {
    const uint16_t dataLen = (uint16_t)(width / 8) * height;
    for (uint16_t i = 0; i < dataLen; i++) frameData[i] ^= 0xFF;
  }

  display->clearBuffer();
  display->setDrawColor(1);
  display->drawBitmap(0, 0, width / 8, height, frameData);

  // With default R0: apply 180 rotation only when flip mode is on
  if (getFlipMode()) {
    uint8_t        *buf = display->getBufferPtr();
    const uint16_t  len = 1024;
    for (uint16_t i = 0; i < len / 2; i++) {
      uint8_t tmp      = buf[i];
      buf[i]           = buf[len - 1 - i];
      buf[len - 1 - i] = tmp;
    }
    for (uint16_t i = 0; i < len; i++) {
      uint8_t b = buf[i];
      b = ((b & 0xF0) >> 4) | ((b & 0x0F) << 4);
      b = ((b & 0xCC) >> 2) | ((b & 0x33) << 2);
      b = ((b & 0xAA) >> 1) | ((b & 0x55) << 1);
      buf[i] = b;
    }
  }

  display->sendBuffer();
}
