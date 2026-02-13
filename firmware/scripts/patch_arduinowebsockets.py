"""
PlatformIO pre-build script: patch ArduinoWebsockets for ESP32 + Cloudflare.

Patches applied:
1. _CONNECTION_TIMEOUT 1000 -> 5000
   Cloudflare injects large headers (Report-To, NEL ~500+ bytes) in WebSocket
   101 responses. The default 1000ms timeout is too short for ESP32 to read
   these headers byte-by-byte over TLS.

2. ESP32 TLS insecure mode support
   The library's upgradeToSecuredConnection() for ESP32 never calls
   setInsecure() on WiFiClientSecure, so TLS cert validation always fails
   when no CA cert is provided. This adds setInsecure() to SecuredEsp32TcpClient
   and calls it automatically when no CA cert is configured (matching ESP8266's
   existing behavior).
"""

Import("env")
import os

libdeps = env.subst("$PROJECT_LIBDEPS_DIR")
pioenv  = env.subst("$PIOENV")
ws_base = os.path.join(libdeps, pioenv, "ArduinoWebsockets", "src")

# -- Patch 1: Connection timeout --
ws_config = os.path.join(ws_base, "tiny_websockets", "ws_config_defs.hpp")
if os.path.exists(ws_config):
    with open(ws_config, "r") as f:
        content = f.read()
    if "_CONNECTION_TIMEOUT 1000" in content:
        content = content.replace("_CONNECTION_TIMEOUT 1000", "_CONNECTION_TIMEOUT 5000")
        with open(ws_config, "w") as f:
            f.write(content)
        print("[patch] ws_config_defs.hpp: _CONNECTION_TIMEOUT 1000 -> 5000")
    else:
        print("[patch] ws_config_defs.hpp: timeout already patched")
else:
    print("[patch] ws_config_defs.hpp: not found, skipping")

# -- Patch 2: Add setInsecure() to SecuredEsp32TcpClient --
esp32_tcp = os.path.join(ws_base, "tiny_websockets", "network", "esp32", "esp32_tcp.hpp")
if os.path.exists(esp32_tcp):
    with open(esp32_tcp, "r") as f:
        content = f.read()
    if "void setInsecure()" not in content:
        old = '''void setPrivateKey(const char* private_key) {
      this->client.setPrivateKey(private_key);
    }'''
        new = old + '''

    void setInsecure() {
      this->client.setInsecure();
    }'''
        if old in content:
            content = content.replace(old, new)
            with open(esp32_tcp, "w") as f:
                f.write(content)
            print("[patch] esp32_tcp.hpp: added setInsecure() to SecuredEsp32TcpClient")
        else:
            print("[patch] esp32_tcp.hpp: setPrivateKey block not found, skipping")
    else:
        print("[patch] esp32_tcp.hpp: setInsecure() already present")
else:
    print("[patch] esp32_tcp.hpp: not found, skipping")

# -- Patch 3: Call setInsecure() in upgradeToSecuredConnection() --
ws_client = os.path.join(ws_base, "websockets_client.cpp")
if os.path.exists(ws_client):
    with open(ws_client, "r") as f:
        content = f.read()
    marker = "// [patch] match ESP8266 behavior"
    if marker not in content:
        old_block = '''if(this->_optional_ssl_private_key) {
            client->setPrivateKey(this->_optional_ssl_private_key);
        }
    #endif'''
        new_block = '''if(this->_optional_ssl_private_key) {
            client->setPrivateKey(this->_optional_ssl_private_key);
        }
        if(!this->_optional_ssl_ca_cert) { // [patch] match ESP8266 behavior
            client->setInsecure();
        }
    #endif'''
        if old_block in content:
            content = content.replace(old_block, new_block)
            with open(ws_client, "w") as f:
                f.write(content)
            print("[patch] websockets_client.cpp: added setInsecure() fallback for ESP32")
        else:
            print("[patch] websockets_client.cpp: target block not found, skipping")
    else:
        print("[patch] websockets_client.cpp: already patched")
else:
    print("[patch] websockets_client.cpp: not found, skipping")
