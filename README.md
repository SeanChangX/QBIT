<p align="right"><a href="README.zh-TW.md">繁體中文</a></p>

<div align="center">

# QBIT

**An open-source ESP32-C3 desktop companion robot and personal IoT avatar.**

[![License: CC BY-NC-SA 4.0](https://img.shields.io/badge/License-CC_BY--NC--SA_4.0-blue.svg)](https://creativecommons.org/licenses/by-nc-sa/4.0/)
[![Platform](https://img.shields.io/badge/Platform-ESP32--C3-green.svg)](#hardware-requirements)
[![Web Platform](https://img.shields.io/badge/Web-qbit.labxcloud.com-purple.svg)](https://qbit.labxcloud.com)

<br>

[![Assembly Video](https://img.youtube.com/vi/pUKB8I10Yfk/maxresdefault.jpg)](https://youtu.be/pUKB8I10Yfk)

*Click the image above to watch the assembly video on YouTube.*

</div>

<br>

<table>
<tr>
<td width="50%" align="center">
<img src="docs/images/Network.png" alt="Network" width="100%">
<br><strong>Network</strong><br>Real-time device graph
</td>
<td width="50%" align="center">
<img src="docs/images/Poke.png" alt="Poke" width="100%">
<br><strong>Poke</strong><br>Send messages to devices
</td>
</tr>
<tr>
<td width="50%" align="center">
<img src="docs/images/Flash.png" alt="Flash" width="100%">
<br><strong>Flash</strong><br>Browser-based firmware flasher
</td>
<td width="50%" align="center">
<img src="docs/images/Library.png" alt="Library" width="100%">
<br><strong>Library</strong><br>Community animation repository
</td>
</tr>
</table>

<br>

<div align="center">

[**Getting Started**](#getting-started) &#8226;
[**Hardware**](#hardware-requirements) &#8226;
[**Web Platform**](#web-platform) &#8226;
[**MQTT**](#mqtt--home-assistant) &#8226;
[**Self-Hosting**](#self-hosting-the-web-platform) &#8226;
[**Build from Source**](#firmware-build-from-source)

</div>

---

## Hardware Requirements

### Components

| Component | Specification | Notes |
|---|---|---|
| MCU | ESP32-C3 Super Mini (e.g. Seeed XIAO ESP32-C3) | Valid GPIOs: 0-10, 20, 21 |
| OLED Display | SSD1306 128x64, I2C, address 0x3C | SH1106-compatible clones also supported |
| Touch Sensor | TTP223 capacitive touch module | Digital output (HIGH when touched) |
| Buzzer | Passive buzzer | Driven via PWM (LEDC) |

### Wiring

Default pin assignments for the ESP32-C3 Super Mini. All pins can be reassigned through the web dashboard at `http://qbit.local` and are stored in NVS (persistent across reboots; changes require a reboot to take effect).

| Function | Default GPIO | Direction | Connection |
|---|---|---|---|
| Touch Sensor (TTP223) | GPIO 1 | Input | TTP223 OUT -> GPIO 1 |
| Buzzer | GPIO 2 | Output | GPIO 2 -> Buzzer +, Buzzer - -> GND |
| OLED SDA | GPIO 20 | I2C Data | SSD1306 SDA -> GPIO 20 |
| OLED SCL | GPIO 21 | I2C Clock | SSD1306 SCL -> GPIO 21 |

Power connections:

| Component | VCC | GND |
|---|---|---|
| SSD1306 OLED | 3.3V | GND |
| TTP223 Touch Sensor | 3.3V | GND |
| Passive Buzzer | -- | GND |

The I2C bus runs at 400 kHz. No external pull-up resistors are needed if the OLED module has built-in pull-ups (most breakout boards do).

---

## Getting Started

### Flash Firmware

The easiest way to flash QBIT firmware is through the browser-based flasher. No toolchain installation is required.

1. Open the [QBIT Firmware Flasher](https://seanchangx.github.io/QBIT/) in Chrome or Edge (version 89+).
2. Connect your QBIT board via USB.
3. Click **Connect & Flash** and select the serial port.
4. The flasher will write the bootloader, partition table, firmware, and filesystem image automatically.

### Initial Wi-Fi Setup

After flashing, the QBIT boots into Wi-Fi provisioning mode:

1. The OLED displays: `[ Wi-Fi Setup ] Connect to 'QBIT' AP to set Wi-Fi.`
2. Connect your phone or computer to the `QBIT` Wi-Fi access point.
3. A captive portal opens automatically. Select your home Wi-Fi network and enter the password.
4. QBIT saves the credentials to NVS and reboots.

If the provisioning screen is displayed for more than 10 seconds without user action, QBIT begins playing animations automatically while keeping the AP open for configuration.

### Device Dashboard

Once connected to Wi-Fi, the QBIT hosts a local web dashboard accessible at:

```
http://qbit.local
```

From the dashboard you can:

- View the unique device ID and set a custom display name
- Adjust display brightness, buzzer volume, and animation playback speed
- Upload and manage .qgif animation files
- Configure a local MQTT broker connection for home automation (see [MQTT & Home Assistant](#mqtt--home-assistant))

---

## Web Platform

The QBIT web platform can be self-hosted and provides a central interface for monitoring and interacting with all your online QBIT devices.

If you use the official firmware, your device will automatically connect to the official server:
[https://qbit.labxcloud.com](https://qbit.labxcloud.com)

If you prefer, you can deploy your own web platform and backend on your own server, and configure the firmware to connect to your custom domain.

### Network

The Network page shows all currently connected QBIT devices as an interactive graph powered by [vis-js/vis-network](https://github.com/visjs/vis-network). Each node displays the device name. Devices that have been online longer are drawn closer to the central hub. The current number of online devices is displayed at the bottom.

Clicking a device node opens a poke dialog where logged-in users can:

- **Poke** -- send a text message (up to 25 characters) to the device. Both the sender name and message text are rendered as 1-bit bitmaps on the web to support multi-language display (including CJK and emoji) on the monochrome OLED. If the text exceeds the screen width, it scrolls horizontally.
- **Claim** -- bind a device to your account (see [Device Claiming](#device-claiming)). Claimed devices show the owner's name and avatar on the graph node.
- **Unclaim** -- remove your ownership of a claimed device.

### Flash

The Flash page embeds the browser-based firmware flasher, allowing users to flash their QBIT directly from the web platform without visiting a separate site.

### Library

The Library page is a community-driven repository of .qgif animation files.

---

## Animation Format (.qgif)

QBIT uses a custom binary animation format (`.qgif`) optimized for the 128x64 monochrome OLED. The format stores 1-bit monochrome frames with per-frame delay values.

<details>
<summary><strong>Binary layout</strong></summary>
<br>

| Offset | Type | Description |
|---|---|---|
| 0 | uint8 | Frame count |
| 1-2 | uint16 LE | Width (pixels) |
| 3-4 | uint16 LE | Height (pixels) |
| 5+ | uint16 LE[] | Per-frame delay (ms), one per frame |
| ... | uint8[] | Frame data: 1024 bytes per frame (128x64 / 8), row-major |

</details>

### Converting GIFs

Use the included conversion tool to create .qgif files from standard GIF animations:

```bash
pip install Pillow
python tools/gif2qbit.py input.gif
python tools/gif2qbit.py input.gif --threshold 100 --invert --scale stretch
python tools/gif2qbit.py *.gif
```

Options:

| Flag | Description |
|---|---|
| `-o` / `--output` | Output file path |
| `--threshold` | Binarization threshold (0-255, default 128) |
| `--invert` | Invert black/white |
| `--scale` | Scaling mode: `fit` (default), `stretch`, `crop` |

### Converting .qgif to C Header

To embed a .qgif animation into firmware as a PROGMEM constant (e.g. for idle or boot animations):

```bash
python tools/qgif2header.py firmware/include/sys_idle.qgif
```

This generates a C header file with the animation data as an `AnimatedGIF` struct, ready for `#include` in firmware source.

---

## MQTT & Home Assistant

QBIT supports local MQTT integration with automatic Home Assistant discovery. Configure the MQTT broker connection from the device dashboard at `http://qbit.local`.

Once connected, the device publishes HA discovery payloads that automatically create the following entities in Home Assistant:

| Entity | Type | Description |
|---|---|---|
| Status | Binary Sensor | Online/offline connectivity status |
| IP | Sensor | Device local IP address |
| Poke | Button | Send a poke message to the device |
| Last Poke | Sensor | Last received poke (sender name, message text as attributes) |

<details>
<summary><strong>MQTT topics</strong> (default prefix <code>qbit</code>)</summary>
<br>

| Topic | Description |
|---|---|
| `qbit/<id>/status` | `online` / `offline` (retained, with LWT) |
| `qbit/<id>/info` | Device info JSON (`id`, `name`, `ip`) |
| `qbit/<id>/command` | Command input (subscribe). Accepts `{"command":"poke","sender":"...","text":"..."}` |
| `qbit/<id>/poke` | Poke event output (published when a poke is received from any source) |

</details>

---

## Device Claiming

Logged-in users can claim a QBIT device to bind it to their account. Claimed devices display the owner's name and avatar on the Network graph.

**Claiming flow:**

1. Click a device on the Network page and select "Claim this device".
2. Enter the full 12-character device ID (printed on the device dashboard).
3. The web sends a claim request to the device via WebSocket.
4. The QBIT OLED displays the requester's name and prompts for a long-press confirmation.
5. Long-press the touch button on the device to confirm, or wait 30 seconds to reject.
6. On confirmation, the claim is stored on the server and the device shows the owner's avatar on the graph.

**Unclaiming:**

Click a claimed device on the Network page and select "Unclaim this device". Only the owner can unclaim.

---

## Self-Hosting the Web Platform

### Prerequisites

- A Linux server (VPS) with Docker and Docker Compose installed
- A domain name with DNS managed by Cloudflare (or any reverse proxy that provides TLS)
- A Google Cloud project with OAuth 2.0 credentials

<details>
<summary><strong>Architecture</strong></summary>
<br>

```
Internet
  |
  +-- Cloudflare Tunnel / Reverse Proxy (TLS termination)
        |
        +-- frontend (Nginx, port 80)
        |     |-- Serves React SPA
        |     |-- Proxies /api/, /auth/, /socket.io/, /device to backend
        |
        +-- backend (Node.js, port 3001)
              |-- REST API (devices, poke, library, claims)
              |-- Google OAuth (Passport.js)
              |-- Socket.io (real-time frontend updates)
              |-- WebSocket /device (ESP32 device connections)
              |-- Persistent storage volume (/data)
```

Only the frontend container exposes a port to the host. The backend communicates with the frontend container via the Docker internal network. External traffic reaches the services through your reverse proxy or Cloudflare Tunnel.

</details>

### Environment Variables

Copy the example and fill in your values:

```bash
cd web
cp .env.example .env
```

| Variable | Description |
|---|---|
| `GOOGLE_CLIENT_ID` | OAuth 2.0 client ID from Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | OAuth 2.0 client secret |
| `GOOGLE_CALLBACK_URL` | OAuth callback URL, e.g. `https://yourdomain.com/auth/google/callback` |
| `SESSION_SECRET` | Random string (at least 32 chars) for session encryption |
| `COOKIE_DOMAIN` | Parent domain for cookies, e.g. `.yourdomain.com` |
| `FRONTEND_URL` | Full frontend URL for CORS, e.g. `https://yourdomain.com` |
| `DEVICE_API_KEY` | Shared secret between backend and ESP32 firmware |
| `MAX_DEVICE_CONNECTIONS` | Max simultaneous device WebSocket connections (default: 100) |

Generate secure random values:

```bash
openssl rand -hex 32   # for SESSION_SECRET
openssl rand -hex 32   # for DEVICE_API_KEY
```

The `DEVICE_API_KEY` value must match the `WS_API_KEY` compiled into the firmware. When using GitHub Actions CI, this is injected automatically via the `QBIT_WS_API_KEY` repository secret.

### Local Development

```bash
cd web
docker compose -f docker-compose.dev.yml up --build
```

| Endpoint | URL |
|---|---|
| Frontend | http://localhost:3000 |
| Backend API | http://localhost:3001 |
| Health check | http://localhost:3001/health |

The health check endpoint returns a human-readable ASCII table dashboard showing server status, connected devices (with local/public IPs), claims, online users, and library file count. Append `?format=json` for JSON output.

For Google OAuth to work locally, add `http://localhost:3000/auth/google/callback` to the Authorized Redirect URIs in Google Cloud Console.

### Production Deployment

```bash
cd web
docker compose up --build -d
```

This starts the frontend (exposed on port 3000) and backend (internal only) containers. Point your reverse proxy or Cloudflare Tunnel to the frontend service on port 3000. The frontend Nginx configuration handles proxying all API, auth, WebSocket, and Socket.io traffic to the backend internally.

Verify the deployment:

```bash
docker compose ps           # both containers should be running
docker compose logs backend # should show "QBIT backend listening on port 3001"
curl http://localhost:3000/health  # server status dashboard
```

### GitHub Actions CI/CD

Two workflows are included:

**Build and Release** (`build-and-release.yml`) -- triggered on version tags (`v*`):
- Compiles firmware with PlatformIO
- Builds the LittleFS filesystem image from `firmware/data/`
- Injects `WS_HOST` and `WS_API_KEY` from repository secrets (`QBIT_WS_HOST`, `QBIT_WS_API_KEY`)
- Creates a GitHub Release with `firmware.bin`, `littlefs.bin`, `bootloader.bin`, and `partitions.bin`

**Deploy Flasher** (`deploy-gh-pages.yml`) -- triggered after a successful build or on push to main:
- Downloads the latest release artifacts
- Generates `manifest.json` for esp-web-tools with partition offsets matching `firmware/partitions.csv`
- Deploys the flasher tool to GitHub Pages

To set up CI/CD, add these repository secrets in GitHub (Settings > Secrets and variables > Actions > Repository secrets):

| Secret | Value |
|---|---|
| `QBIT_WS_HOST` | Your backend domain (e.g. `qbit.labxcloud.com`) |
| `QBIT_WS_API_KEY` | Same value as `DEVICE_API_KEY` in your `.env` |

---

## Firmware Build from Source

Requirements: [PlatformIO CLI](https://docs.platformio.org/en/latest/core/installation/index.html)

```bash
cd firmware
pio run --target upload         # compile and flash firmware
pio run --target uploadfs       # upload LittleFS filesystem (animations, web dashboard)
pio device monitor              # open serial monitor (115200 baud)
```

The firmware connects to the backend WebSocket server using the `WS_HOST`, `WS_PORT`, and `WS_API_KEY` defines in `firmware/src/main.cpp`. For local development, the defaults point to `localhost:3001`. For production builds via GitHub Actions, these values are injected from repository secrets at compile time.

Custom partition table ([`firmware/partitions.csv`](firmware/partitions.csv))

---

## Tools

| Tool | Description |
|---|---|
| `tools/gif2qbit.py` | Convert standard GIF animations to the .qgif format |
| `tools/qgif2header.py` | Convert .qgif files to C header files for PROGMEM embedding |
| `tools/simulate-devices.py` | Simulate multiple QBIT devices connecting to the backend for testing |
| `tools/flasher/` | Browser-based firmware flasher (deployed to GitHub Pages) |

---

## License

[![License: CC BY-NC-SA 4.0](https://img.shields.io/badge/License-CC%20BY--NC--SA%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by-nc-sa/4.0/)

This project is licensed under the [Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0)](https://creativecommons.org/licenses/by-nc-sa/4.0/).

Commercial use of this project or any derivative works is not permitted without explicit permission from the author. For commercial licensing, contact: scx@gapp.nthu.edu.tw
