#!/usr/bin/env python3
"""
Simulate multiple QBIT devices connecting to the backend.
Devices appear when the script runs and disappear when stopped (Ctrl+C).

Usage:
  python simulate-devices.py                     # 5 devices on localhost
  python simulate-devices.py -n 20               # 20 devices
  python simulate-devices.py -n 10 --host wss://qbit.labxcloud.com
  python simulate-devices.py -n 3 --host ws://localhost:3000 --key dev-test-key

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


def device_thread(index, url, stop_event):
    """Run a single simulated device connection."""
    device_id = make_device_id(index)
    device_name = make_device_name(device_id)

    hello = json.dumps({
        "type": "hello",
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
            ws.connect(url)
            ws.send(hello)
            print(f"  [+] #{index:>3d}  {device_id}  {device_name}")

            # Stay connected, respond to pings
            while not stop_event.is_set():
                ws.settimeout(5)
                try:
                    ws.recv()
                except websocket.WebSocketTimeoutException:
                    continue
                except Exception:
                    break

        except Exception as e:
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
    parser.add_argument("-n", "--count", type=int, default=5, help="Number of devices (default: 5)")
    parser.add_argument("--host", type=str, default="ws://localhost:3000",
                        help="Backend WebSocket base URL (default: ws://localhost:3000)")
    parser.add_argument("--key", type=str, default="",
                        help="Device API key (must match backend DEVICE_API_KEY)")
    args = parser.parse_args()

    path = "/device"
    if args.key:
        path += f"?key={args.key}"
    url = args.host.rstrip("/") + path

    print(f"Simulating {args.count} devices -> {url}")
    print("Press Ctrl+C to disconnect all and exit.\n")

    stop_event = threading.Event()
    threads = []

    for i in range(args.count):
        t = threading.Thread(target=device_thread, args=(i, url, stop_event), daemon=True)
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
