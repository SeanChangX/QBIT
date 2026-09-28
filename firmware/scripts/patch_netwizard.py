"""
PlatformIO pre-build script: patch NetWizard 1.2.2 _stopPortal() (#29).

Patches applied:
1. Clear pending /netwizard/exit at the start of _stopPortal()
   The /netwizard/exit handler arms a delayed stop (NETWIZARD_EXIT_TIMEOUT).
   If QBIT already stopped the portal after provisioning SUCCESS, the stale
   exit flag would run _stopPortal() a second time a few seconds later.

2. Keep an established STA link when stopping the portal
   _stopPortal() always calls WiFi.begin() after tearing down the Soft AP,
   even when STA is already connected, which drops the link and forces a
   full reconnect. Only reconnect when STA is actually down.
"""

Import("env")
import os

libdeps = env.subst("$PROJECT_LIBDEPS_DIR")
pioenv  = env.subst("$PIOENV")
nw_cpp  = os.path.join(libdeps, pioenv, "NetWizard", "src", "NetWizard.cpp")

if os.path.exists(nw_cpp):
    with open(nw_cpp, "r") as f:
        content = f.read()
    changed = False

    # -- Patch 1: Clear pending exit flag --
    marker1 = "// [patch] QBIT: clear pending /netwizard/exit"
    if marker1 not in content:
        old = '''void NetWizard::_stopPortal() {
  // Stop HTTP'''
        new = '''void NetWizard::_stopPortal() {
  // [patch] QBIT: clear pending /netwizard/exit so it cannot re-run _stopPortal() later
  _nw.portal.exit.flag = false;
  _nw.portal.exit.millis = 0;

  // Stop HTTP'''
        if old in content:
            content = content.replace(old, new)
            changed = True
            print("[patch] NetWizard.cpp: clear exit flag in _stopPortal()")
        else:
            print("[patch] NetWizard.cpp: _stopPortal() header not found, skipping exit flag patch")
    else:
        print("[patch] NetWizard.cpp: exit flag already patched")

    # -- Patch 2: Do not force WiFi.begin() when STA is already connected --
    marker2 = "// [patch] QBIT: keep established STA link"
    if marker2 not in content:
        old = '''    WiFi.mode(WIFI_STA);
    WiFi.persistent(false);
    _connect(_nw.sta.ssid.c_str(), _nw.sta.password.c_str(), true);
  } else {
    NETWIZARD_DEBUG_MSG("Switching off wifi as the device is not configured\\n");'''
        new = '''    WiFi.mode(WIFI_STA);
    WiFi.persistent(false);
    // [patch] QBIT: keep established STA link instead of forcing WiFi.begin()
    if (WiFi.status() == WL_CONNECTED) {
      #if defined(ESP8266) || defined(ESP32)
        WiFi.setAutoReconnect(true);
      #endif
      _nw.status = NetWizardConnectionStatus::CONNECTED;
    } else {
      _connect(_nw.sta.ssid.c_str(), _nw.sta.password.c_str(), true);
    }
  } else {
    NETWIZARD_DEBUG_MSG("Switching off wifi as the device is not configured\\n");'''
        if old in content:
            content = content.replace(old, new)
            changed = True
            print("[patch] NetWizard.cpp: keep STA link in _stopPortal()")
        else:
            print("[patch] NetWizard.cpp: _stopPortal() reconnect block not found, skipping")
    else:
        print("[patch] NetWizard.cpp: STA reconnect already patched")

    if changed:
        with open(nw_cpp, "w") as f:
            f.write(content)
else:
    print("[patch] NetWizard.cpp: not found, skipping")
