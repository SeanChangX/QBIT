// ==========================================================================
//  QBIT -- QR code generation + OLED rendering
// ==========================================================================
#include "qr_code.h"
#include "app_state.h"
#include "display_helpers.h"
#include "qrcode.h"

void showWifiQR(const char *ssid, const char *password) {
    // Build WiFi QR content string
    String content = "WIFI:T:WPA;S:";
    content += ssid;
    content += ";P:";
    content += password;
    content += ";;";

    // QR version 3 = 29x29 modules
    QRCode qrcode;
    uint8_t qrcodeData[qrcode_getBufferSize(3)];
    qrcode_initText(&qrcode, qrcodeData, 3, ECC_LOW, content.c_str());

    // 2px per module: 29*2 = 58px wide, 58px tall
    const uint8_t scale = 2;
    uint8_t qrSize = qrcode.size * scale;  // 58

    // Center horizontally, leave room for text at bottom
    uint8_t offsetX = (128 - qrSize) / 2;  // 35
    uint8_t offsetY = 0;                     // top-aligned

    u8g2.clearBuffer();

    // Draw QR modules
    for (uint8_t y = 0; y < qrcode.size; y++) {
        for (uint8_t x = 0; x < qrcode.size; x++) {
            if (qrcode_getModule(&qrcode, x, y)) {
                // Draw a scale x scale filled rectangle
                u8g2.drawBox(offsetX + x * scale,
                             offsetY + y * scale,
                             scale, scale);
            }
        }
    }

    // Label below QR code
    u8g2.setFont(u8g2_font_5x7_tr);
    const char *label = "Scan to connect";
    uint8_t labelW = u8g2.getStrWidth(label);
    u8g2.drawStr((128 - labelW) / 2, 64, label);

    rotateBuffer180();
    u8g2.sendBuffer();
}
