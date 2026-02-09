import { useState, useEffect, useCallback, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import Navbar from './components/Navbar';
import NetworkGraph from './components/NetworkGraph';
import PokeDialog from './components/PokeDialog';
import type { BitmapPayload } from './components/PokeDialog';
import ClaimDialog from './components/ClaimDialog';
import FlashPage from './components/FlashPage';
import LibraryPage from './components/LibraryPage';
import type { Device, User } from './types';

export type Page = 'network' | 'flash' | 'library';

const API_URL = import.meta.env.VITE_API_URL || '';

export default function App() {
  const [page, setPage] = useState<Page>('network');
  const [devices, setDevices] = useState<Device[]>([]);
  const [user, setUser] = useState<User | null>(null);
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null);
  const [claimDevice, setClaimDevice] = useState<Device | null>(null);
  const socketRef = useRef<Socket | null>(null);

  // Fetch current user on mount
  useEffect(() => {
    fetch(`${API_URL}/auth/me`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((u) => setUser(u))
      .catch(() => setUser(null));
  }, []);

  // Socket.io connection for real-time device updates
  useEffect(() => {
    const s = io(API_URL || window.location.origin, {
      withCredentials: true,
    });

    s.on('devices:update', (data: Device[]) => {
      setDevices(data);
    });

    socketRef.current = s;
    return () => {
      s.disconnect();
    };
  }, []);

  // Send poke to a device (with optional bitmap data)
  const handlePoke = useCallback(
    async (targetId: string, text: string, bitmapData?: BitmapPayload) => {
      try {
        const body: Record<string, unknown> = { targetId, text };
        if (bitmapData) {
          body.senderBitmap = bitmapData.senderBitmap;
          body.senderBitmapWidth = bitmapData.senderBitmapWidth;
          body.textBitmap = bitmapData.textBitmap;
          body.textBitmapWidth = bitmapData.textBitmapWidth;
        }

        const res = await fetch(`${API_URL}/api/poke`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const data = await res.json();
          alert(data.error || 'Failed to send poke');
          return;
        }
      } catch {
        alert('Network error');
        return;
      }
      setSelectedDevice(null);
    },
    []
  );

  // Unclaim a device
  const handleUnclaim = useCallback(
    async (device: Device) => {
      if (!confirm(`Unclaim ${device.name}?`)) return;
      try {
        const res = await fetch(`${API_URL}/api/claim/${device.id}`, {
          method: 'DELETE',
          credentials: 'include',
        });
        if (!res.ok) {
          const data = await res.json();
          alert(data.error || 'Failed to unclaim');
          return;
        }
      } catch {
        alert('Network error');
        return;
      }
      setSelectedDevice(null);
    },
    []
  );

  // Handle device click: show options (poke / claim)
  const handleDeviceSelect = useCallback((device: Device) => {
    setSelectedDevice(device);
  }, []);

  return (
    <div className="app">
      <Navbar user={user} apiUrl={API_URL} page={page} setPage={setPage} />
      <main className="main">
        {page === 'network' && (
          <>
            {devices.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">&#9211;</div>
                <p>No QBIT devices online</p>
                <p className="empty-sub">
                  Devices will appear here when they connect.
                </p>
              </div>
            ) : (
              <NetworkGraph
                devices={devices}
                onSelectDevice={handleDeviceSelect}
              />
            )}
            {devices.length > 0 && (
              <div className="network-device-count">
                {devices.length} device{devices.length !== 1 ? 's' : ''} online
              </div>
            )}
          </>
        )}
        {page === 'flash' && <FlashPage />}
        {page === 'library' && <LibraryPage user={user} apiUrl={API_URL} />}
      </main>
      {selectedDevice && (
        <PokeDialog
          device={selectedDevice}
          user={user}
          onPoke={handlePoke}
          onClaim={(device) => {
            setSelectedDevice(null);
            setClaimDevice(device);
          }}
          onUnclaim={handleUnclaim}
          onClose={() => setSelectedDevice(null)}
          isLoggedIn={!!user}
          apiUrl={API_URL}
        />
      )}
      {claimDevice && (
        <ClaimDialog
          device={claimDevice}
          apiUrl={API_URL}
          onClose={() => setClaimDevice(null)}
          onClaimed={() => setClaimDevice(null)}
        />
      )}
    </div>
  );
}
