// ==========================================================================
//  QBIT -- RTOS primitive instantiation & global objects
// ==========================================================================
#include "app_state.h"

// RTOS handles (created in main.cpp setup())
QueueHandle_t       gestureQueue      = nullptr;
QueueHandle_t       networkEventQueue = nullptr;
EventGroupHandle_t  connectivityBits  = nullptr;
SemaphoreHandle_t   displayMutex      = nullptr;
SemaphoreHandle_t   gifPlayerMutex    = nullptr;

// Global display object (reconstructed via placement new in setup())
U8G2_SSD1306_128X64_NONAME_F_HW_I2C u8g2(
    U8G2_R0, /* reset= */ U8X8_PIN_NONE,
    /* clock= */ 21, /* data= */ 20);

const char *kQbitVersion = (QBIT_VERSION[0] != '\0')
                           ? QBIT_VERSION
                           : "dev-build";

volatile bool updateAvailable = false;
char         updateAvailableVersion[UPDATE_AVAILABLE_VERSION_LEN] = "";
