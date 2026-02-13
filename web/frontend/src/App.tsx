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
      }, 10000);
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
      <a
        className="github-link"
        href="https://github.com/SeanChangX/QBIT"
        target="_blank"
        rel="noreferrer"
        aria-label="QBIT GitHub repository"
      >
        <svg
          viewBox="0 0 24 24"
          width="18"
          height="18"
          aria-hidden="true"
        >
          <path
            fill="currentColor"
            d="M12 0.5C5.37 0.5 0 5.87 0 12.5c0 5.29 3.44 9.78 8.2 11.37.6.11.82-.26.82-.58 0-.29-.01-1.05-.02-2.06-3.34.74-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.76.08-.75.08-.75 1.2.08 1.83 1.23 1.83 1.23 1.07 1.83 2.8 1.3 3.49.99.11-.78.42-1.3.76-1.6-2.66-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.23-3.22-.12-.3-.53-1.53.12-3.2 0 0 1.01-.32 3.3 1.23.96-.27 2-.41 3.03-.41 1.03 0 2.07.14 3.03.41 2.29-1.55 3.3-1.23 3.3-1.23.65 1.67.24 2.9.12 3.2.76.84 1.23 1.91 1.23 3.22 0 4.61-2.81 5.62-5.49 5.92.43.37.82 1.1.82 2.22 0 1.6-.02 2.9-.02 3.3 0 .32.22.7.82.58 4.76-1.59 8.2-6.08 8.2-11.37C24 5.87 18.63 0.5 12 0.5z"
          />
        </svg>
      </a>
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
