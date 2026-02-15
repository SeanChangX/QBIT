// ==========================================================================
//  QBIT -- Shared application state & RTOS primitives
// ==========================================================================
#ifndef APP_STATE_H
#define APP_STATE_H

#include <Arduino.h>
#include <U8g2lib.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/event_groups.h>
#include <freertos/semphr.h>

// ==========================================================================
//  Display states (state machine for display task)
// ==========================================================================
enum DisplayState {
    BOOT_ANIM,
    WIFI_SETUP,
    CONNECTED_INFO,
    GIF_PLAYBACK,
    POKE_DISPLAY,
    CLAIM_PROMPT,
    HISTORY_TIME,
    HISTORY_POKE,
    MUTE_FEEDBACK,
    OFFLINE_STATUS
};

// ==========================================================================
//  Gesture types (input task → display task)
// ==========================================================================
enum GestureType {
    GESTURE_NONE,
    TOUCH_DOWN,
    SINGLE_TAP,
    DOUBLE_TAP,
    LONG_PRESS
};

struct GestureEvent {
    GestureType type;
    unsigned long timestamp;
};

// ==========================================================================
//  Network events (network task → display task)
// ==========================================================================
struct NetworkEvent {
    enum Kind {
        POKE,
        POKE_BITMAP,
        CLAIM_REQUEST,
        WIFI_STATUS,
        WS_STATUS,
        MQTT_COMMAND
    } kind;

    // Event-specific data
    char sender[33];
    char text[65];

    // Bitmap poke data (heap pointers, receiver must free)
    uint8_t *senderBmp;
    uint16_t senderBmpWidth;
    size_t   senderBmpLen;
    uint8_t *textBmp;
    uint16_t textBmpWidth;
    size_t   textBmpLen;

    // Status flags
    bool connected;
};

// ==========================================================================
//  Poke history record
// ==========================================================================
struct PokeRecord {
    String sender;
    String text;
    time_t timestamp;

    // Optional bitmap data (copies, owned by this record)
    uint8_t *senderBmp   = nullptr;
    uint16_t senderBmpW  = 0;
    uint16_t senderBmpH  = 0;
    uint8_t *textBmp     = nullptr;
    uint16_t textBmpW    = 0;
    uint16_t textBmpH    = 0;
    bool     hasBitmaps  = false;

    void freeBitmaps() {
        if (senderBmp) { free(senderBmp); senderBmp = nullptr; }
        if (textBmp)   { free(textBmp);   textBmp   = nullptr; }
        hasBitmaps = false;
        senderBmpW = senderBmpH = 0;
        textBmpW   = textBmpH   = 0;
    }
};

// ==========================================================================
//  Connectivity event group bits
// ==========================================================================
#define WIFI_CONNECTED_BIT  (1 << 0)
#define WS_CONNECTED_BIT    (1 << 1)
#define MQTT_CONNECTED_BIT  (1 << 2)

// ==========================================================================
//  RTOS handles (instantiated in app_state.cpp)
// ==========================================================================
extern QueueHandle_t       gestureQueue;
extern QueueHandle_t       networkEventQueue;
extern EventGroupHandle_t  connectivityBits;
extern SemaphoreHandle_t   displayMutex;
extern SemaphoreHandle_t   gifPlayerMutex;

// ==========================================================================
//  Global display object
// ==========================================================================
extern U8G2_SSD1306_128X64_NONAME_F_HW_I2C u8g2;

// ==========================================================================
//  Firmware version
// ==========================================================================
#ifndef QBIT_VERSION
#define QBIT_VERSION "dev-build"
#endif

extern const char *kQbitVersion;

#endif // APP_STATE_H
