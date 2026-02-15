// ==========================================================================
//  QBIT -- MQTT Home Assistant discovery + publish helpers
// ==========================================================================
#ifndef MQTT_HA_H
#define MQTT_HA_H

#include <PubSubClient.h>
#include "app_state.h"

// Publish HA auto-discovery config for all entities.
void mqttPublishHADiscovery(PubSubClient *client);

// Publish helpers (call from any context — they check connection internally)
void mqttPublishPokeEvent(const char *sender, const char *text);
void mqttPublishMuteState(bool muted);
void mqttPublishTouchEvent(GestureType type);
void mqttPublishAnimationState(const String &filename);

#endif // MQTT_HA_H
