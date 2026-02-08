# QBIT

An open-source ESP32-C3 desktop companion robot and personal IoT avatar.

![QBIT Thumbnail](docs/images/Thumbnail.jpg)

---

## Table of Contents

- [Getting Started](#getting-started)
  - [Flash Firmware](#flash-firmware)
  - [Initial Wi-Fi Setup](#initial-wi-fi-setup)
  - [Device Dashboard](#device-dashboard)
- [Web Platform](#web-platform)
  - [Network](#network)
  - [Flash](#flash)
  - [Library](#library)
- [Animation Format (.qgif)](#animation-format-qgif)
- [Self-Hosting the Web Platform](#self-hosting-the-web-platform)
  - [Prerequisites](#prerequisites)
  - [Architecture](#architecture)
  - [Environment Variables](#environment-variables)
  - [Local Development](#local-development)
  - [Production Deployment](#production-deployment)
  - [GitHub Actions CI/CD](#github-actions-cicd)
- [Firmware Build from Source](#firmware-build-from-source)
- [License](#license)

---

## Getting Started

### Flash Firmware

The easiest way to flash QBIT firmware is through the browser-based flasher. No toolchain installation is required.

1. Open the [QBIT Firmware Flasher](https://seanchangx.github.io/QBIT/) in Chrome or Edge (version 89+).
2. Connect your QBIT board via USB.
3. Click **Connect & Flash** and select the serial port.
4. The flasher will write the bootloader, partition table, firmware, and filesystem image automatically.

<!-- Screenshot: Flash page -->
<!-- ![Flash Page](docs/images/flash-page.png) -->

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

- View the unique device ID
- Set a custom display name
- Adjust display brightness, buzzer volume, and animation playback speed
- Upload and manage .qgif animation files
- Configure a local MQTT broker connection for home automation

---

## Web Platform

The QBIT web platform can be self-hosted and provides a central interface for monitoring and interacting with all your online QBIT devices.

If you use the official firmware, your device will automatically connect to the official server:  
[https://qbit.labxcloud.com](https://qbit.labxcloud.com)

If you prefer, you can deploy your own web platform and backend on your own server, and configure the firmware to connect to your custom domain.

### Network

The Network page shows all currently connected QBIT devices as an interactive graph powered by [vis-js/vis-network](https://github.com/visjs/vis-network). Each node displays the device name. Clicking a device node opens a poke dialog where logged-in users can send a text message to the device. The QBIT OLED will display the message and play a notification sound.

<!-- Screenshot: Network page -->
<!-- ![Network Page](docs/images/network-page.png) -->

### Flash

The Flash page embeds the browser-based firmware flasher, allowing users to flash their QBIT directly from the web platform without visiting a separate site.

<!-- Screenshot: Flash page in web platform -->
<!-- ![Flash Tab](docs/images/flash-tab.png) -->

### Library

The Library page is a community-driven repository of .qgif animation files. Logged-in users can upload their own animations, and anyone can browse, preview (with animated canvas rendering), and download files.

Each entry displays:
- File name, frame count, and file size
- Uploader name and upload date
- Animated preview rendered on a canvas element
- Download link

<!-- Screenshot: Library page -->
<!-- ![Library Page](docs/images/library-page.png) -->

---

## Animation Format (.qgif)

QBIT uses a custom binary animation format (`.qgif`) optimized for the 128x64 monochrome OLED. The format stores 1-bit monochrome frames with per-frame delay values.

Binary layout:

| Offset | Type | Description |
|---|---|---|
| 0 | uint8 | Frame count |
| 1-2 | uint16 LE | Width (pixels) |
| 3-4 | uint16 LE | Height (pixels) |
| 5+ | uint16 LE[] | Per-frame delay (ms), one per frame |
| ... | uint8[] | Frame data: 1024 bytes per frame (128x64 / 8), row-major |

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

---

## Self-Hosting the Web Platform

### Prerequisites

- A Linux server (VPS) with Docker and Docker Compose installed
- A domain name with DNS managed by Cloudflare (or any reverse proxy that provides TLS)
- A Google Cloud project with OAuth 2.0 credentials

### Architecture

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
              |-- REST API (devices, poke, library)
              |-- Google OAuth (Passport.js)
              |-- Socket.io (real-time frontend updates)
              |-- WebSocket /device (ESP32 device connections)
              |-- Persistent storage volume (/data)
```

Only the frontend container exposes a port to the host. The backend communicates with the frontend container via the Docker internal network. External traffic reaches the services through your reverse proxy or Cloudflare Tunnel.

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
```

### GitHub Actions CI/CD

Two workflows are included:

**Build and Release** (`build-and-release.yml`) -- triggered on version tags (`v*`):
- Compiles firmware with PlatformIO
- Injects `WS_HOST` and `WS_API_KEY` from repository secrets (`QBIT_WS_HOST`, `QBIT_WS_API_KEY`)
- Creates a GitHub Release with firmware.bin, littlefs.bin, bootloader.bin, and partitions.bin

**Deploy Flasher** (`deploy-gh-pages.yml`) -- triggered after a successful build or on push to main:
- Downloads the latest release artifacts
- Generates `manifest.json` for esp-web-tools
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

Custom partition table ([`firmware/partitions.csv`](firmware/partitions.csv)):

---

## License

[![License: CC BY-NC-SA 4.0](https://img.shields.io/badge/License-CC%20BY--NC--SA%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by-nc-sa/4.0/)

This project is licensed under the [Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0)](https://creativecommons.org/licenses/by-nc-sa/4.0/).

Commercial use of this project or any derivative works is not permitted without explicit permission from the author. For commercial licensing, contact: scx@gapp.nthu.edu.tw
