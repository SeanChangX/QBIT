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

// Time when WiFi was declared lost (0 if connected or not yet lost). Used for AP countdown.
unsigned long networkGetWifiLostMs();

#endif // NETWORK_TASK_H
