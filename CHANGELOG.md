# Changelog

All notable changes to the QBIT firmware are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

A release tag `vX.Y.Z` is the firmware version a device reports and the web flasher installs.
The web platform (`web/`) is deployed continuously and is not versioned here. Releases before
1.9.4 are listed on [GitHub Releases](https://github.com/SeanChangX/QBIT/releases).

## [Unreleased]

## [1.9.4] - 2026-11-11

### Fixed

- WiFi no longer drops right after the setup portal closes on boards such as the ESP32-C3
  SuperMini ([#29](https://github.com/SeanChangX/QBIT/issues/29)). Raising the transmit power
  back to 19.5 dBm while the board reconnected left many of them unable to connect, bouncing
  between the home network and the setup portal.
- Closing the setup portal keeps an established WiFi connection instead of dropping and
  reconnecting it, and a late "exit" from the setup page can no longer close the portal twice.

### Changed

- WiFi transmit power is fixed at 13 dBm for both the setup portal and the home network. Builds
  that need more range can raise it with `-DQBIT_WIFI_TX_POWER=WIFI_POWER_19_5dBm` in
  `platformio.ini`.

### Security

- ESPAsyncWebServer 3.10.0 → 3.12.1 and AsyncTCP 3.4.10 → 3.5.0. Earlier versions let anyone on
  the same network, or connected to the setup portal, crash the device with a crafted upload
  request ([GHSA-4phx-fcj6-46r4](https://github.com/advisories/GHSA-4phx-fcj6-46r4),
  [GHSA-8m8p-vhxc-jmjw](https://github.com/advisories/GHSA-8m8p-vhxc-jmjw)).

[Unreleased]: https://github.com/SeanChangX/QBIT/compare/v1.9.4...HEAD
[1.9.4]: https://github.com/SeanChangX/QBIT/compare/v1.9.3...v1.9.4
