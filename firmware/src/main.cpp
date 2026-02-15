// ==========================================================================
//  QBIT -- Firmware main (RTOS architecture)
// ==========================================================================

#include <Arduino.h>
#include <WiFi.h>
#include <ESPAsyncWebServer.h>
#include <U8g2lib.h>
#include <Wire.h>
#include <NetWizard.h>
#include <ESPmDNS.h>
#include <new>

#include "app_state.h"
#include "settings.h"
#include "display_helpers.h"
#include "gif_player.h"
#include "web_dashboard.h"
#include "display_task.h"
#include "network_task.h"
#include "input_task.h"

#include "gif_types.h"
#include "sys_idle.h"

// ==========================================================================
//  Web server (shared by NetWizard and web dashboard)
// ==========================================================================

AsyncWebServer server(80);
NetWizard      NW(&server);

// ==========================================================================
//  Arduino setup()
// ==========================================================================

void setup() {
    Serial.begin(115200);
    Serial.setDebugOutput(false);

    // 1. NVS + pin config
    settingsInit();
    pinMode(getPinTouch(), INPUT);
    pinMode(getPinBuzzer(), OUTPUT);

    // 2. Display (reconstruct U8G2 with NVS pins)
    new (&u8g2) U8G2_SSD1306_128X64_NONAME_F_HW_I2C(
        U8G2_R0, U8X8_PIN_NONE, getPinSCL(), getPinSDA());
    u8g2.setBusClock(400000);
    u8g2.begin();
    clearFullGDDRAM();
    setDisplayInvert(false);

    // 3. Load settings + apply brightness
    loadSettings();
    setDisplayBrightness(getDisplayBrightnessVal());

    // 4. Create RTOS primitives
    gestureQueue      = xQueueCreate(8, sizeof(GestureEvent));
    networkEventQueue = xQueueCreate(16, sizeof(NetworkEvent));
    connectivityBits  = xEventGroupCreate();
    displayMutex      = xSemaphoreCreateMutex();
    gifPlayerMutex    = xSemaphoreCreateMutex();

    // 5. GIF player + idle animation
    gifPlayerInit(&u8g2);
    gifPlayerSetIdleAnimation(&sys_idle_gif);

    // 6. NetWizard (NON_BLOCKING) with MAC-derived AP password
    String apPwd = getApPassword();

    NW.onConnectionStatus([](NetWizardConnectionStatus status) {
        if (status == NetWizardConnectionStatus::CONNECTED) {
            xEventGroupSetBits(connectivityBits, WIFI_CONNECTED_BIT);
        } else if (status == NetWizardConnectionStatus::CONNECTION_LOST ||
                   status == NetWizardConnectionStatus::DISCONNECTED) {
            xEventGroupClearBits(connectivityBits, WIFI_CONNECTED_BIT);
        }
    });

    NW.setStrategy(NetWizardStrategy::NON_BLOCKING);
    NW.autoConnect("QBIT", apPwd.c_str());

    // 7. mDNS
    if (MDNS.begin("qbit")) {
        MDNS.addService("http", "tcp", 80);
    }

    // 8. Web dashboard + server
    webDashboardInit(server);
    server.begin();

    Serial.println("Web server started");

    // 9. Launch RTOS tasks
    xTaskCreate(displayTask, "display", 8192, NULL, 2, NULL);
    xTaskCreate(networkTask, "network", 8192, NULL, 1, NULL);
    xTaskCreate(inputTask,   "input",   2048, NULL, 3, NULL);
}

// ==========================================================================
//  Arduino loop() — all work done in RTOS tasks
// ==========================================================================

void loop() {
    vTaskDelete(NULL);
}
