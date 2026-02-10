import { useState, useEffect, useCallback, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import Navbar from './components/Navbar';
import NetworkGraph from './components/NetworkGraph';
import PokeDialog from './components/PokeDialog';
import type { BitmapPayload } from './components/PokeDialog';
import UserPokeDialog from './components/UserPokeDialog';
import ClaimDialog from './components/ClaimDialog';
import FlashPage from './components/FlashPage';
import LibraryPage from './components/LibraryPage';
import type { Device, User, OnlineUser } from './types';

export type Page = 'network' | 'flash' | 'library';

const API_URL = import.meta.env.VITE_API_URL || '';

interface PokeNotification {
  id: number;
  from: string;
  text: string;
  exiting?: boolean;
}

export default function App() {
  const [page, setPage] = useState<Page>('network');
  const [devices, setDevices] = useState<Device[]>([]);
  const [onlineUsers, setOnlineUsers] = useState<OnlineUser[]>([]);
  const [user, setUser] = useState<User | null>(null);
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null);
  const [selectedUser, setSelectedUser] = useState<OnlineUser | null>(null);
  const [claimDevice, setClaimDevice] = useState<Device | null>(null);
  const [notifications, setNotifications] = useState<PokeNotification[]>([]);
  const notificationIdRef = useRef(0);
  const socketRef = useRef<Socket | null>(null);

  // Fetch current user on mount
  useEffect(() => {
    fetch(`${API_URL}/auth/me`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((u) => setUser(u))
      .catch(() => setUser(null));
  }, []);

  // Socket.io connection for real-time device and user updates
  useEffect(() => {
    const s = io(API_URL || window.location.origin, {
      withCredentials: true,
    });

    s.on('devices:update', (data: Device[]) => {
      setDevices(data);
    });

    s.on('users:update', (data: OnlineUser[]) => {
      setOnlineUsers(data);
    });

    s.on('poke', (data: { from: string; text: string }) => {
      const id = ++notificationIdRef.current;
      setNotifications((prev) => {
        const next = [...prev, { id, from: data.from, text: data.text }];
        return next.slice(-3);
      });
      setTimeout(() => {
        setNotifications((prev) =>
          prev.map((n) => (n.id === id ? { ...n, exiting: true } : n))
        );
        setTimeout(() => {
          setNotifications((prev) => prev.filter((n) => n.id !== id));
        }, 300);
      }, 5000);
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

  // Handle user click: show user poke dialog
  const handleUserSelect = useCallback((onlineUser: OnlineUser) => {
    setSelectedUser(onlineUser);
  }, []);

  // Send poke to an online user
  const handleUserPoke = useCallback(
    async (targetUserId: string, text: string) => {
      try {
        const res = await fetch(`${API_URL}/api/poke/user`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ targetUserId, text }),
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
      setSelectedUser(null);
    },
    []
  );

  const hasNetworkNodes = devices.length > 0 || onlineUsers.length > 0;

  return (
    <div className="app">
      <Navbar user={user} apiUrl={API_URL} page={page} setPage={setPage} />
      <main className="main">
        {page === 'network' && (
          <>
            {!hasNetworkNodes ? (
              <div className="empty-state">
                <div className="empty-icon" aria-hidden>
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
                    <line x1="12" y1="2" x2="12" y2="12" />
                  </svg>
                </div>
                <p>No QBIT devices online</p>
                <p className="empty-sub">
                  Devices will appear here when they connect.
                </p>
              </div>
            ) : (
              <NetworkGraph
                devices={devices}
                onlineUsers={onlineUsers}
                currentUserId={user?.id ?? null}
                onSelectDevice={handleDeviceSelect}
                onSelectUser={handleUserSelect}
              />
            )}
            {hasNetworkNodes && (
              <div className="network-device-count">
                {devices.length > 0 && (
                  <span>{devices.length} device{devices.length !== 1 ? 's' : ''}</span>
                )}
                {devices.length > 0 && onlineUsers.length > 0 && ' · '}
                {onlineUsers.length > 0 && (
                  <span>{onlineUsers.length} user{onlineUsers.length !== 1 ? 's' : ''}</span>
                )}
                {' online'}
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
      {selectedUser && (
        <UserPokeDialog
          target={selectedUser}
          onPoke={handleUserPoke}
          onClose={() => setSelectedUser(null)}
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
      <div className="poke-notifications" aria-live="polite">
        {notifications.map((n) => (
          <div
            key={n.id}
            className={`poke-notification ${n.exiting ? 'poke-notification-exit' : 'poke-notification-enter'}`}
          >
            <div className="poke-notification-from">Poke from {n.from}</div>
            <div className="poke-notification-text">{n.text}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
