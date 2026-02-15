// ==========================================================================
//  QBIT -- QR code display for WiFi provisioning
// ==========================================================================
#ifndef QR_CODE_H
#define QR_CODE_H

#include <Arduino.h>

// Display a WiFi QR code on the OLED.
// Content: WIFI:T:WPA;S:<ssid>;P:<password>;;
// Renders centered on 128x64 OLED with "Scan to connect" label.
void showWifiQR(const char *ssid, const char *password);

#endif // QR_CODE_H
