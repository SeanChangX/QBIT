#!/usr/bin/env python3
"""
Simulate multiple QBIT devices connecting to the backend.
Devices appear when the script runs and disappear when stopped (Ctrl+C).

Usage:
  python simulate-devices.py                     # 5 devices on localhost
  python simulate-devices.py -n 20               # 20 devices
  python simulate-devices.py -n 10 --host wss://qbit.labxcloud.com
  python simulate-devices.py -n 3 --host ws://localhost:3000 --key dev-test-key
  python simulate-devices.py -n 2 --auto-claim   # auto-confirm claim requests

Requirements:
  pip install websocket-client
"""

import argparse
import json
import random
import signal
import sys
import threading
import time

try:
    import websocket
except ImportError:
    print("Error: websocket-client is required.  Install with:  pip install websocket-client")
    sys.exit(1)


def make_device_id(index):
    """Generate a fake 12-char hex device ID."""
    return f"SIM{index:04d}00{random.randint(0x1000, 0xFFFF):04X}"


def make_device_name(device_id):
    """Generate a name like 'QBIT-XXXX' using the last 4 chars of the ID."""
    return f"QBIT-{device_id[-4:]}"


def handle_message(ws, device_id, device_name, msg_data, auto_claim):
    """Process an incoming message from the backend."""
    try:
        msg = json.loads(msg_data)
    except (json.JSONDecodeError, TypeError):
        return

    msg_type = msg.get("type", "")

    if msg_type == "poke":
        sender = msg.get("sender", "?")
        text = msg.get("text", "")
        has_bitmap = bool(msg.get("senderBitmap"))
        mode = "bitmap" if has_bitmap else "text"
        print(f"  [!] {device_name}  poke ({mode}) from {sender}: {text}")

    elif msg_type == "claim_request":
        user_name = msg.get("userName", "Unknown")
        print(f"  [?] {device_name}  claim request from {user_name}", end="")
        if auto_claim:
            # Simulate a short delay (like a long-press) then confirm
            print(" -> auto-confirming in 2s...")
            time.sleep(2)
            ws.send(json.dumps({"type": "claim_confirm"}))
            print(f"  [v] {device_name}  claim confirmed for {user_name}")
        else:
            print(" (ignored, use --auto-claim to accept)")


def device_thread(index, url, stop_event, auto_claim, api_key):
    """Run a single simulated device connection."""
    device_id = make_device_id(index)
    device_name = make_device_name(device_id)

    register_msg = json.dumps({
        "type": "device.register",
        "id": device_id,
        "name": device_name,
        "ip": f"192.168.1.{100 + index}",
        "version": "SIM",
    })

    while not stop_event.is_set():
        ws = None
        try:
            ws = websocket.WebSocket()
            ws.settimeout(10)
            headers = []
            if api_key:
                headers.append(f"Authorization: Bearer {api_key}")
            ws.connect(url, header=headers)
            ws.send(register_msg)
            print(f"  [+] #{index:>3d}  {device_id}  {device_name}")

            # Stay connected, handle incoming messages
            while not stop_event.is_set():
                ws.settimeout(5)
                try:
                    data = ws.recv()
                    if data:
                        handle_message(ws, device_id, device_name, data, auto_claim)
                except websocket.WebSocketTimeoutException:
                    continue
                except Exception:
                    break

        except Exception:
            if not stop_event.is_set():
                # Retry after a short delay
                time.sleep(2)
        finally:
            if ws:
                try:
                    ws.close()
                except Exception:
                    pass

    print(f"  [-] #{index:>3d}  {device_id}  {device_name}")


def main():
    parser = argparse.ArgumentParser(description="Simulate QBIT devices online.")
    parser.add_argument("-n", "--count", type=int, default=5,
                        help="Number of devices (default: 5)")
    parser.add_argument("--host", type=str, default="ws://localhost:3000",
                        help="Backend WebSocket base URL (default: ws://localhost:3000)")
    parser.add_argument("--key", type=str, default="",
                        help="Device API key (must match backend DEVICE_API_KEY)")
    parser.add_argument("--auto-claim", action="store_true",
                        help="Automatically confirm claim requests (simulates long-press)")
    args = parser.parse_args()

    path = "/device"
    url = args.host.rstrip("/") + path

    print(f"Simulating {args.count} devices -> {url}")
    if args.auto_claim:
        print("Auto-claim: ON (claim requests will be confirmed after 2s)")
    print("Press Ctrl+C to disconnect all and exit.\n")

    stop_event = threading.Event()
    threads = []

    for i in range(args.count):
        t = threading.Thread(target=device_thread,
                             args=(i, url, stop_event, args.auto_claim, args.key),
                             daemon=True)
        t.start()
        threads.append(t)
        time.sleep(0.05)  # slight stagger to avoid connection burst

    def shutdown(sig=None, frame=None):
        print("\n\nDisconnecting all devices...")
        stop_event.set()
        for t in threads:
            t.join(timeout=5)
        print("Done.")
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    # Keep main thread alive
    while True:
        time.sleep(1)


if __name__ == "__main__":
    main()
