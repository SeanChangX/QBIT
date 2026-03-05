import { useState, useEffect, useCallback, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import Navbar from './components/Navbar';
import NetworkGraph from './components/NetworkGraph';
import PokeDialog from './components/PokeDialog';
import type { BitmapPayload } from './components/PokeDialog';
import UserPokeDialog from './components/UserPokeDialog';
import ClaimDialog from './components/ClaimDialog';
import AddFriendDialog from './components/AddFriendDialog';
import FlashPage from './components/FlashPage';
import LibraryPage from './components/LibraryPage';
import PokeHistoryPanel from './components/PokeHistoryPanel';
import ReportDialog from './components/ReportDialog';
import type { Device, User, OnlineUser } from './types';
import { isTTSSupported, speakPokeMessage } from './utils/tts';
import { getPokeHistory, addPokeHistory, clearPokeHistory, type PokeHistoryEntry } from './utils/pokeHistory';

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
  const [addFriendDevice, setAddFriendDevice] = useState<Device | null>(null);
  const [friendIds, setFriendIds] = useState<string[]>([]);
  const [friendDisplayNames, setFriendDisplayNames] = useState<Record<string, string>>({});
  const [friendAvatars, setFriendAvatars] = useState<Record<string, string>>({});
  const [friendPairs, setFriendPairs] = useState<Array<{ a: string; b: string }>>([]);
  const [onlyFriendsCanPoke, setOnlyFriendsCanPoke] = useState(false);
  const [publicFriends, setPublicFriends] = useState(true);
  const [notifications, setNotifications] = useState<PokeNotification[]>([]);
  const [showPokeHistory, setShowPokeHistory] = useState(false);
  const [pokeHistoryEntries, setPokeHistoryEntries] = useState<PokeHistoryEntry[]>([]);
  const [showReport, setShowReport] = useState(false);
  const notificationIdRef = useRef(0);
  const socketRef = useRef<Socket | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const fetchFriendsRef = useRef<() => void>(() => {});
  const addFriendDeviceRef = useRef<Device | null>(null);
  const networkBarTouchStartRef = useRef<number | null>(null);
  const networkBarMouseStartRef = useRef<number | null>(null);
  const pillOpenedByMouseDragRef = useRef(false);
  const [isPillMouseDragging, setIsPillMouseDragging] = useState(false);
  const [pokeHighlight, setPokeHighlight] = useState<{ deviceId?: string; publicUserId?: string; seq: number } | null>(null);

  const openPokeHistoryIfSwipeUp = useCallback((startY: number, endY: number) => {
    if (startY - endY > 28) {
      setPokeHistoryEntries(getPokeHistory());
      setShowPokeHistory(true);
    }
  }, []);

  useEffect(() => {
    if (!isPillMouseDragging) return;
    const handleMouseMove = (e: MouseEvent) => {
      const startY = networkBarMouseStartRef.current;
      if (startY == null) return;
      if (startY - e.clientY > 28) {
        pillOpenedByMouseDragRef.current = true;
        setPokeHistoryEntries(getPokeHistory());
        setShowPokeHistory(true);
        networkBarMouseStartRef.current = null;
        setIsPillMouseDragging(false);
      }
    };
    const handleMouseUp = (e: MouseEvent) => {
      const startY = networkBarMouseStartRef.current;
      if (startY != null) {
        if (startY - e.clientY > 28) pillOpenedByMouseDragRef.current = true;
        openPokeHistoryIfSwipeUp(startY, e.clientY);
      }
      networkBarMouseStartRef.current = null;
      setIsPillMouseDragging(false);
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isPillMouseDragging, openPokeHistoryIfSwipeUp]);

  // Fetch current user on mount
  useEffect(() => {
    fetch(`${API_URL}/auth/me`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((u) => setUser(u))
      .catch(() => setUser(null));
  }, []);

  // Fetch friends (when logged in) and global friend pairs (always, no login required)
  const fetchFriends = useCallback(() => {
    if (user) {
      fetch(`${API_URL}/api/friends`, { credentials: 'include' })
        .then((r) => (r.ok ? r.json() : { friendIds: [], friends: [] }))
        .then((data) => {
          const ids = data.friendIds || [];
          const friends = data.friends || [];
          setFriendIds(ids);
          const names: Record<string, string> = {};
          const avatars: Record<string, string> = {};
          friends.forEach((f: { publicUserId: string; displayName: string; avatar?: string }) => {
            names[f.publicUserId] = f.displayName ?? 'Friend';
            avatars[f.publicUserId] = f.avatar ?? '';
          });
          setFriendDisplayNames(names);
          setFriendAvatars(avatars);
        })
        .catch(() => {
          setFriendIds([]);
          setFriendDisplayNames({});
          setFriendAvatars({});
        });
    } else {
      setFriendIds([]);
      setFriendDisplayNames({});
      setFriendAvatars({});
    }
    fetch(`${API_URL}/api/friends/pairs`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : { friendPairs: [] }))
      .then((data) => setFriendPairs(data.friendPairs || []))
      .catch(() => setFriendPairs([]));
  }, [user]);
  const fetchSettings = useCallback(() => {
    if (!user) {
      setOnlyFriendsCanPoke(false);
      setPublicFriends(true);
      return;
    }
    fetch(`${API_URL}/api/me/settings`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : { onlyFriendsCanPoke: false, publicFriends: true }))
      .then((data) => {
        setOnlyFriendsCanPoke(!!data.onlyFriendsCanPoke);
        setPublicFriends(data.publicFriends !== false);
      })
      .catch(() => {
        setOnlyFriendsCanPoke(false);
        setPublicFriends(true);
      });
  }, [user]);
  useEffect(() => {
    fetchFriends();
    fetchSettings();
  }, [fetchFriends, fetchSettings]);

  useEffect(() => {
    addFriendDeviceRef.current = addFriendDevice;
  }, [addFriendDevice]);

  fetchFriendsRef.current = fetchFriends;

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

    s.on('poke:highlight', (data: { deviceId?: string; publicUserId?: string }) => {
      const { deviceId, publicUserId } = data;
      setPokeHighlight((prev) => {
        const same = prev && (
          (deviceId != null && prev.deviceId === deviceId) ||
          (publicUserId != null && prev.publicUserId === publicUserId)
        );
        const seq = same ? Math.min(prev!.seq + 1, 5) : 1;
        return { deviceId, publicUserId, seq };
      });
    });

    s.on('friends:update', () => {
      setAddFriendDevice(null);
      fetchFriendsRef.current();
    });

    s.on('friend_request:result', () => {
      setAddFriendDevice(null);
    });

    s.on('poke', (data: { from: string; text: string }) => {
      addPokeHistory({ fromUserId: '', fromName: data.from, direction: 'received', text: data.text });
      const id = ++notificationIdRef.current;
      setNotifications((prev) => {
        const next = [...prev, { id, from: data.from, text: data.text }];
        return next.slice(-3);
      });
      if (isTTSSupported()) {
        speakPokeMessage(data.from, data.text);
      }
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
    setSocket(s);
    return () => {
      s.disconnect();
      setSocket(null);
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

  // Send poke to an online user (target by publicUserId)
  const handleUserPoke = useCallback(
    async (targetPublicUserId: string, text: string, targetDisplayName?: string) => {
      try {
        const res = await fetch(`${API_URL}/api/poke/user`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ targetPublicUserId, text }),
        });
        if (!res.ok) {
          const data = await res.json();
          alert(data.error || 'Failed to send poke');
          return;
        }
        addPokeHistory({
          fromUserId: targetPublicUserId,
          fromName: targetDisplayName ?? 'User',
          direction: 'sent',
          text,
        });
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
                currentUserId={user?.publicUserId ?? null}
                friendIds={friendIds}
                friendPairs={friendPairs}
                pokeHighlight={pokeHighlight}
                onPokeHighlightEnd={() => setPokeHighlight(null)}
                onSelectDevice={handleDeviceSelect}
                onSelectUser={handleUserSelect}
              />
            )}
            {hasNetworkNodes && !showPokeHistory && (
              <div className="network-online-pill-wrap">
                <div className="network-swipe-hint" aria-hidden="true">
                  <svg className="network-swipe-hint-icon" viewBox="0 0 24 24" width="16" height="16">
                    <path fill="currentColor" d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6 1.41 1.41z" />
                  </svg>
                </div>
                <div
                  className="network-device-count"
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    if (pillOpenedByMouseDragRef.current) {
                      pillOpenedByMouseDragRef.current = false;
                      return;
                    }
                    setPokeHistoryEntries(getPokeHistory());
                    setShowPokeHistory(true);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setPokeHistoryEntries(getPokeHistory());
                      setShowPokeHistory(true);
                    }
                  }}
                  onMouseDown={(e) => {
                    networkBarMouseStartRef.current = e.clientY;
                    setIsPillMouseDragging(true);
                  }}
                  onTouchStart={(e) => {
                    networkBarTouchStartRef.current = e.changedTouches[0].clientY;
                  }}
                  onTouchMove={(e) => {
                    const startY = networkBarTouchStartRef.current;
                    if (startY == null) return;
                    const currentY = e.changedTouches[0].clientY;
                    if (startY - currentY > 28) {
                      setPokeHistoryEntries(getPokeHistory());
                      setShowPokeHistory(true);
                      networkBarTouchStartRef.current = null;
                    }
                  }}
                  onTouchEnd={(e) => {
                    const startY = networkBarTouchStartRef.current;
                    if (startY == null) return;
                    const endY = e.changedTouches[0].clientY;
                    if (startY - endY > 28) {
                      setPokeHistoryEntries(getPokeHistory());
                      setShowPokeHistory(true);
                    }
                    networkBarTouchStartRef.current = null;
                  }}
                  aria-label="Device count. Swipe up or tap to open Poke history"
                >
                  <span className="network-device-count-text">
                    {devices.length > 0 && (
                      <span>{devices.length} device{devices.length !== 1 ? 's' : ''}</span>
                    )}
                    {devices.length > 0 && onlineUsers.length > 0 && ' · '}
                    {onlineUsers.length > 0 && (
                      <span>{onlineUsers.length} user{onlineUsers.length !== 1 ? 's' : ''}</span>
                    )}
                    {' online'}
                  </span>
                </div>
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
          onAddFriend={(device) => {
            setSelectedDevice(null);
            setAddFriendDevice(device);
          }}
          onClose={() => setSelectedDevice(null)}
          isLoggedIn={!!user}
          apiUrl={API_URL}
          friendIds={friendIds}
          friendDisplayNames={friendDisplayNames}
          friendAvatars={friendAvatars}
          onlineUsers={onlineUsers}
          onlyFriendsCanPoke={onlyFriendsCanPoke}
          onOnlyFriendsCanPokeChange={async (value) => {
            try {
              const res = await fetch(`${API_URL}/api/me/settings`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ onlyFriendsCanPoke: value }),
              });
              if (res.ok) setOnlyFriendsCanPoke(value);
            } catch {
              // ignore
            }
          }}
          publicFriends={publicFriends}
          onPublicFriendsChange={async (value) => {
            try {
              const res = await fetch(`${API_URL}/api/me/settings`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ publicFriends: value }),
              });
              if (res.ok) {
                setPublicFriends(value);
                fetchFriendsRef.current();
              }
            } catch {
              // ignore
            }
          }}
          onRemoveFriend={async (publicUserId) => {
            const res = await fetch(`${API_URL}/api/friends/${encodeURIComponent(publicUserId)}`, {
              method: 'DELETE',
              credentials: 'include',
            });
            if (!res.ok) {
              const data = await res.json();
              alert(data.error || 'Failed to remove friend');
              return;
            }
            fetchFriendsRef.current();
          }}
        />
      )}
      {selectedUser && (
        <UserPokeDialog
          target={selectedUser}
          onPoke={handleUserPoke}
          onClose={() => setSelectedUser(null)}
          isLoggedIn={!!user}
          apiUrl={API_URL}
          isFriend={friendIds.includes(selectedUser.publicUserId)}
          onRemoveFriend={async (publicUserId) => {
            const res = await fetch(`${API_URL}/api/friends/${encodeURIComponent(publicUserId)}`, {
              method: 'DELETE',
              credentials: 'include',
            });
            if (!res.ok) {
              const data = await res.json();
              alert(data.error || 'Failed to remove friend');
              return;
            }
            fetchFriendsRef.current();
          }}
        />
      )}
      {claimDevice && (
        <ClaimDialog
          device={claimDevice}
          apiUrl={API_URL}
          onClose={() => setClaimDevice(null)}
          onClaimed={() => setClaimDevice(null)}
          socket={socket}
        />
      )}
      {addFriendDevice && (
        <AddFriendDialog
          device={addFriendDevice}
          apiUrl={API_URL}
          onClose={() => setAddFriendDevice(null)}
        />
      )}
      {hasNetworkNodes && (
        <PokeHistoryPanel
          entries={pokeHistoryEntries}
          hasEntries={pokeHistoryEntries.length > 0}
          onClose={() => setShowPokeHistory(false)}
          onClear={() => {
            clearPokeHistory();
            setPokeHistoryEntries([]);
          }}
          visible={showPokeHistory}
        />
      )}
      {showReport && (
        <ReportDialog
          onlineUsers={onlineUsers}
          apiUrl={API_URL}
          onClose={() => setShowReport(false)}
          onSubmitted={() => {}}
        />
      )}
      {page === 'network' && (
        <button
          type="button"
          className={`report-floating-btn${hasNetworkNodes ? ' report-floating-btn-stacked' : ''}`}
          onClick={() => setShowReport(true)}
          title="Report user"
          aria-label="Report user"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path fill="currentColor" d="M14.4 6L14 4H5v17h2v-7h5.6l.4 2h7V6h-5.6z" />
          </svg>
        </button>
      )}
      <a
        className="coffee-link"
        href="https://buymeacoffee.com/SeanChangX"
        target="_blank"
        rel="noreferrer noopener"
        aria-label="Buy Me a Coffee"
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path fill="currentColor" d="M20.216 6.415l-.132-.666c-.119-.598-.388-1.163-1.001-1.379-.197-.069-.42-.098-.57-.241-.152-.143-.196-.366-.231-.572-.065-.378-.125-.756-.192-1.133-.057-.325-.102-.69-.25-.987-.195-.4-.597-.634-.996-.788a5.723 5.723 0 00-.626-.194c-1-.263-2.05-.36-3.077-.416a25.834 25.834 0 00-3.7.062c-.915.083-1.88.184-2.75.5-.318.116-.646.256-.888.501-.297.302-.393.77-.177 1.146.154.267.415.456.692.58.36.162.737.284 1.123.366 1.075.238 2.189.331 3.287.37 1.218.05 2.437.01 3.65-.118.299-.033.598-.073.896-.119.352-.054.578-.513.474-.834-.124-.383-.457-.531-.834-.473-.466.074-.96.108-1.382.146-1.177.08-2.358.082-3.536.006a22.228 22.228 0 01-1.157-.107c-.086-.01-.18-.025-.258-.036-.243-.036-.484-.08-.724-.13-.111-.027-.111-.185 0-.212h.005c.277-.06.557-.108.838-.147h.002c.131-.009.263-.032.394-.048a25.076 25.076 0 013.426-.12c.674.019 1.347.067 2.017.144l.228.031c.267.04.533.088.798.145.392.085.895.113 1.07.542.055.137.08.288.111.431l.319 1.484a.237.237 0 01-.199.284h-.003c-.037.006-.075.01-.112.015a36.704 36.704 0 01-4.743.295 37.059 37.059 0 01-4.699-.304c-.14-.017-.293-.042-.417-.06-.326-.048-.649-.108-.973-.161-.393-.065-.768-.032-1.123.161-.29.16-.527.404-.675.701-.154.316-.199.66-.267 1-.069.34-.176.707-.135 1.056.087.753.613 1.365 1.37 1.502a39.69 39.69 0 0011.343.376.483.483 0 01.535.53l-.071.697-1.018 9.907c-.041.41-.047.832-.125 1.237-.122.637-.553 1.028-1.182 1.171-.577.131-1.165.2-1.756.205-.656.004-1.31-.025-1.966-.022-.699.004-1.556-.06-2.095-.58-.475-.458-.54-1.174-.605-1.793l-.731-7.013-.322-3.094c-.037-.351-.286-.695-.678-.678-.336.015-.718.3-.678.679l.228 2.185.949 9.112c.147 1.344 1.174 2.068 2.446 2.272.742.12 1.503.144 2.257.156.966.016 1.942.053 2.892-.122 1.408-.258 2.465-1.198 2.616-2.657.34-3.332.683-6.663 1.024-9.995l.215-2.087a.484.484 0 01.39-.426c.402-.078.787-.212 1.074-.518.455-.488.546-1.124.385-1.766zm-1.478.772c-.145.137-.363.201-.578.233-2.416.359-4.866.54-7.308.46-1.748-.06-3.477-.254-5.207-.498-.17-.024-.353-.055-.47-.18-.22-.236-.111-.71-.054-.995.052-.26.152-.609.463-.646.484-.057 1.046.148 1.526.22.577.088 1.156.159 1.737.212 2.48.226 5.002.19 7.472-.14.45-.06.899-.13 1.345-.21.399-.072.84-.206 1.08.206.166.281.188.657.162.974a.544.544 0 01-.169.364zm-6.159 3.9c-.862.37-1.84.788-3.109.788a5.884 5.884 0 01-1.569-.217l.877 9.004c.065.78.717 1.38 1.5 1.38 0 0 1.243.065 1.658.065.447 0 1.786-.065 1.786-.065.783 0 1.434-.6 1.499-1.38l.94-9.95a3.996 3.996 0 00-1.322-.238c-.826 0-1.491.284-2.26.613z" />
        </svg>
      </a>
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
