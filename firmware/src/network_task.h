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

// Reset WiFi to initial state and remove saved credentials (NetWizard reset). Device will disconnect.
void networkWifiReset();

// Apply AP RF settings for ESP32-C3 PCB antenna stability (TX power, HT20). Call after portal is up.
void wifiApplyApRfStabilityForPcbAntenna();

#endif // NETWORK_TASK_H
