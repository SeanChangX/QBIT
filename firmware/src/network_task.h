// ==========================================================================
//  QBIT -- Network task (WiFi, WebSocket, MQTT management)
// ==========================================================================
#ifndef NETWORK_TASK_H
#define NETWORK_TASK_H

// FreeRTOS task: manages WiFi, WebSocket, MQTT connections.
// Priority 1, stack 8192 bytes.
void networkTask(void *param);

// Send device info to backend WebSocket (thread-safe, call from any context).
void networkSendDeviceInfo();

// Send claim confirm/reject to backend WebSocket.
void networkSendClaimConfirm();
void networkSendClaimReject();

// Send friend confirm/reject to backend WebSocket.
void networkSendFriendConfirm();
void networkSendFriendReject();

// Time when WiFi was declared lost (0 if connected or not yet lost). Used for AP countdown.
unsigned long networkGetWifiLostMs();

// Boot uptime (seconds since power-on). On ESP32 uses esp_timer (64-bit us), not millis() wrap (~49d).
unsigned long networkGetBootUptimeSeconds();

// Backend WebSocket (cloud server) connection state and uptime since last connect.
bool          networkIsCloudWsConnected();
unsigned long networkGetCloudWsUptimeSeconds();

// Reset WiFi to initial state and remove saved credentials (NetWizard reset). Device will disconnect.
void networkWifiReset();

// Apply AP RF settings for ESP32-C3 PCB antenna stability (TX power, HT20). Call after portal is up.
void wifiApplyApRfStabilityForPcbAntenna();
// Restore default TX power when running as STA (connected). Call when WiFi just connected; 13dBm from AP fix would otherwise persist and weaken STA.
void wifiRestoreStaTxPower();

#endif // NETWORK_TASK_H
