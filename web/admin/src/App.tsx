import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  VirtualList,
  VIRTUAL_CONTAINER_HEIGHT,
  VIRTUAL_LIST_ROW_HEIGHT,
  VIRTUAL_BAN_ROW_HEIGHT,
} from './VirtualScroll';

interface Session {
  socketId: string;
  userId: string;
  displayName: string;
  email: string;
  avatar?: string;
  ip: string;
  connectedAt: string;
}

interface KnownUser {
  userId: string;
  displayName: string;
  email: string;
  avatar: string;
  firstSeen: string;
  lastSeen: string;
  status: 'online' | 'offline';
}

interface Claim {
  deviceId: string;
  deviceName: string | null;
  userId: string;
  userName: string;
  userAvatar: string;
  claimedAt: string;
}

interface Device {
  id: string;
  name: string;
  ip: string;
  publicIp?: string;
  version: string;
  lastSeen: string;
  status: 'online' | 'offline';
}

interface BannedList {
  userIds: string[];
  ips: string[];
  deviceIds: string[];
}

async function load<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: 'include' });
  if (r.status === 401) throw new Error('UNAUTHORIZED');
  if (r.status === 429) throw new Error('Too many requests. Please try again later.');
  if (!r.ok) throw new Error(r.statusText);
  return r.json();
}

async function post(url: string, body: object): Promise<void> {
  const r = await fetch(url, {
    credentials: 'include',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (r.status === 401) throw new Error('UNAUTHORIZED');
  if (!r.ok) throw new Error(r.statusText);
}

async function del(url: string, body: object): Promise<void> {
  const r = await fetch(url, {
    credentials: 'include',
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (r.status === 401) throw new Error('UNAUTHORIZED');
  if (!r.ok) throw new Error(r.statusText);
}

export default function App() {
  const [auth, setAuth] = useState<boolean | null>(null);
  const showLoginModal = auth === false;
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');

  const ADMIN_USERNAME_MAX_LEN = 64;
  const ADMIN_PASSWORD_MIN_LEN = 8;
  const ADMIN_PASSWORD_MAX_LEN = 128;
  const [sessions, setSessions] = useState<Session[]>([]);
  const [users, setUsers] = useState<KnownUser[]>([]);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [bans, setBans] = useState<BannedList>({ userIds: [], ips: [], deviceIds: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [banUserId, setBanUserId] = useState('');
  const [banIp, setBanIp] = useState('');

  const refresh = useCallback(async (showLoading = true) => {
    setError(null);
    if (showLoading) setLoading(true);
    try {
      const [s, u, c, d, b] = await Promise.all([
        load<Session[]>('/api/sessions'),
        load<KnownUser[]>('/api/users'),
        load<Claim[]>('/api/claims'),
        load<Device[]>('/api/devices'),
        load<BannedList>('/api/bans'),
      ]);
      setSessions(s);
      setUsers(u);
      setClaims(c);
      setDevices(d);
      setBans(b);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load';
      if (msg === 'UNAUTHORIZED') {
        setAuth(false);
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const sessionCheckDone = useRef(false);
  useEffect(() => {
    if (sessionCheckDone.current) return;
    sessionCheckDone.current = true;
    let cancelled = false;
    fetch('/api/sessions', { credentials: 'include' })
      .then((r) => {
        if (cancelled) return;
        setAuth(r.ok);
      })
      .catch(() => {
        if (!cancelled) setAuth(false);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (auth !== true) return;
    refresh(true);
    const t = setInterval(() => refresh(false), 10000);
    return () => clearInterval(t);
  }, [auth, refresh]);

  const handleLogin = useCallback(async () => {
    setLoginError(null);
    const user = loginUsername.trim();
    const pass = loginPassword;
    if (user.length === 0 || user.length > ADMIN_USERNAME_MAX_LEN) {
      setLoginError(`Username: 1–${ADMIN_USERNAME_MAX_LEN} characters`);
      return;
    }
    if (pass.length < ADMIN_PASSWORD_MIN_LEN || pass.length > ADMIN_PASSWORD_MAX_LEN) {
      setLoginError(`Password: ${ADMIN_PASSWORD_MIN_LEN}–${ADMIN_PASSWORD_MAX_LEN} characters`);
      return;
    }
    try {
      const r = await fetch('/api/admin/login', {
        credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user, password: pass }),
      });
      if (r.status === 401) {
        setLoginError('Invalid username or password');
        return;
      }
      if (r.status === 429) {
        setLoginError('Too many requests. Please try again later.');
        return;
      }
      if (!r.ok) throw new Error(r.statusText);
      setAuth(true);
      setLoginUsername('');
      setLoginPassword('');
    } catch (e) {
      setLoginError(e instanceof Error ? e.message : 'Login failed');
    }
  }, [loginUsername, loginPassword]);

  const handleUnauthorized = useCallback(() => {
    setAuth(false);
  }, []);

  const handleLogout = useCallback(async () => {
    try {
      await fetch('/api/admin/logout', { credentials: 'include', method: 'POST' });
    } finally {
      setAuth(false);
    }
  }, []);

  const handleBan = useCallback(async () => {
    if (!banUserId.trim() && !banIp.trim()) return;
    try {
      await post('/api/ban', { userId: banUserId.trim() || undefined, ip: banIp.trim() || undefined });
      setBanUserId('');
      setBanIp('');
      await refresh(false);
    } catch (e) {
      if ((e instanceof Error && e.message) === 'UNAUTHORIZED') handleUnauthorized();
      else setError(e instanceof Error ? e.message : 'Ban failed');
    }
  }, [banUserId, banIp, refresh, handleUnauthorized]);

  const handleUnbanUser = useCallback(
    async (userId: string) => {
      try {
        await del('/api/ban', { userId });
        await refresh(false);
      } catch (e) {
        if ((e instanceof Error && e.message) === 'UNAUTHORIZED') handleUnauthorized();
        else setError(e instanceof Error ? e.message : 'Unban failed');
      }
    },
    [refresh, handleUnauthorized]
  );

  const handleUnbanIp = useCallback(
    async (ip: string) => {
      try {
        await del('/api/ban', { ip });
        await refresh(false);
      } catch (e) {
        if ((e instanceof Error && e.message) === 'UNAUTHORIZED') handleUnauthorized();
        else setError(e instanceof Error ? e.message : 'Unban failed');
      }
    },
    [refresh, handleUnauthorized]
  );

  const handleBanSessionUser = useCallback(
    async (userId: string) => {
      try {
        await post('/api/ban', { userId });
        await refresh(false);
      } catch (e) {
        if ((e instanceof Error && e.message) === 'UNAUTHORIZED') handleUnauthorized();
        else setError(e instanceof Error ? e.message : 'Ban failed');
      }
    },
    [refresh, handleUnauthorized]
  );

  const handleBanSessionIp = useCallback(
    async (ip: string) => {
      try {
        await post('/api/ban', { ip });
        await refresh(false);
      } catch (e) {
        if ((e instanceof Error && e.message) === 'UNAUTHORIZED') handleUnauthorized();
        else setError(e instanceof Error ? e.message : 'Ban failed');
      }
    },
    [refresh, handleUnauthorized]
  );

  const handleBanDevice = useCallback(
    async (deviceId: string) => {
      try {
        await post('/api/ban', { deviceId });
        await refresh(false);
      } catch (e) {
        if ((e instanceof Error && e.message) === 'UNAUTHORIZED') handleUnauthorized();
        else setError(e instanceof Error ? e.message : 'Ban failed');
      }
    },
    [refresh, handleUnauthorized]
  );

  const handleUnbanDevice = useCallback(
    async (deviceId: string) => {
      try {
        await del('/api/ban', { deviceId });
        await refresh(false);
      } catch (e) {
        if ((e instanceof Error && e.message) === 'UNAUTHORIZED') handleUnauthorized();
        else setError(e instanceof Error ? e.message : 'Unban failed');
      }
    },
    [refresh, handleUnauthorized]
  );

  const handleDeleteUser = useCallback(
    async (userId: string) => {
      if (!confirm(`Delete user record "${userId}"? This cannot be undone.`)) return;
      try {
        await del(`/api/users/${encodeURIComponent(userId)}`, {});
        await refresh(false);
      } catch (e) {
        if ((e instanceof Error && e.message) === 'UNAUTHORIZED') handleUnauthorized();
        else setError(e instanceof Error ? e.message : 'Delete user failed');
      }
    },
    [refresh, handleUnauthorized]
  );

  const handleUnclaim = useCallback(
    async (deviceId: string) => {
      if (!confirm('Remove claim for this device? The device will become unclaimed.')) return;
      try {
        await del(`/api/claim/${encodeURIComponent(deviceId)}`, {});
        await refresh(false);
      } catch (e) {
        if ((e instanceof Error && e.message) === 'UNAUTHORIZED') handleUnauthorized();
        else setError(e instanceof Error ? e.message : 'Unclaim failed');
      }
    },
    [refresh, handleUnauthorized]
  );

  type DeviceSortKey = 'id' | 'name' | 'ip' | 'publicIp' | 'version' | 'lastSeen';
  const [deviceSortBy, setDeviceSortBy] = useState<DeviceSortKey>('lastSeen');
  const [deviceSortOrder, setDeviceSortOrder] = useState<'asc' | 'desc'>('desc');
  const sortedDevices = useMemo(() => {
    const list = [...devices];
    const cmp = (a: Device, b: Device): number => {
      let va: string | number;
      let vb: string | number;
      switch (deviceSortBy) {
        case 'id':
          va = a.id;
          vb = b.id;
          break;
        case 'name':
          va = a.name;
          vb = b.name;
          break;
        case 'ip':
          va = a.ip;
          vb = b.ip;
          break;
        case 'publicIp':
          va = a.publicIp ?? '';
          vb = b.publicIp ?? '';
          break;
        case 'version':
          va = a.version;
          vb = b.version;
          break;
        case 'lastSeen':
        default:
          va = new Date(a.lastSeen).getTime();
          vb = new Date(b.lastSeen).getTime();
          break;
      }
      if (typeof va === 'string' && typeof vb === 'string') {
        const r = va.localeCompare(vb);
        return deviceSortOrder === 'asc' ? r : -r;
      }
      const r = (va as number) - (vb as number);
      return deviceSortOrder === 'asc' ? r : -r;
    };
    list.sort(cmp);
    return list;
  }, [devices, deviceSortBy, deviceSortOrder]);

  const [selectedDeviceIds, setSelectedDeviceIds] = useState<Set<string>>(new Set());

  const [listRowHeight, setListRowHeight] = useState(VIRTUAL_LIST_ROW_HEIGHT);
  const [banListRowHeight, setBanListRowHeight] = useState(VIRTUAL_BAN_ROW_HEIGHT);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)');
    const update = (): void => {
      setListRowHeight(mq.matches ? 132 : VIRTUAL_LIST_ROW_HEIGHT);
      setBanListRowHeight(mq.matches ? 96 : VIRTUAL_BAN_ROW_HEIGHT);
    };
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  const toggleDeviceSelection = useCallback((id: string) => {
    setSelectedDeviceIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const toggleSelectAllDevices = useCallback(() => {
    if (selectedDeviceIds.size === sortedDevices.length) {
      setSelectedDeviceIds(new Set());
    } else {
      setSelectedDeviceIds(new Set(sortedDevices.map((d) => d.id)));
    }
  }, [sortedDevices, selectedDeviceIds.size]);
  const handleDeleteSelectedDevices = useCallback(async () => {
    if (selectedDeviceIds.size === 0) return;
    if (!confirm(`Delete ${selectedDeviceIds.size} device record(s)? This cannot be undone.`)) return;
    try {
      await del('/api/devices', { deviceIds: [...selectedDeviceIds] });
      setSelectedDeviceIds(new Set());
      await refresh(false);
    } catch (e) {
      if ((e instanceof Error && e.message) === 'UNAUTHORIZED') handleUnauthorized();
      else setError(e instanceof Error ? e.message : 'Delete devices failed');
    }
  }, [selectedDeviceIds, refresh, handleUnauthorized]);

  // Collapsible section state (all collapsed by default except sessions)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({
    bans: true,
    users: true,
    claims: true,
    sessions: false,
    devices: true,
  });
  const toggle = useCallback((key: string) => {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  // Lookup maps for ban list name resolution
  const userMap = useMemo(() => {
    const m = new Map<string, KnownUser>();
    users.forEach((u) => m.set(u.userId, u));
    return m;
  }, [users]);

  // Build a device name map from both online devices AND claims
  const deviceNameMap = useMemo(() => {
    const m = new Map<string, string>();
    // Online devices (current name)
    devices.forEach((d) => m.set(d.id, d.name));
    // Claims (device name at claim time, fallback for offline devices)
    claims.forEach((c) => {
      if (c.deviceName && !m.has(c.deviceId)) {
        m.set(c.deviceId, c.deviceName);
      }
    });
    return m;
  }, [devices, claims]);

  // Flatten bans for virtual list: [{ type: 'user'|'ip'|'device', id: string }, ...]
  const bansFlat = useMemo(() => {
    const out: { type: 'user' | 'ip' | 'device'; id: string }[] = [];
    (bans.userIds ?? []).forEach((id) => out.push({ type: 'user', id }));
    (bans.ips ?? []).forEach((ip) => out.push({ type: 'ip', id: ip }));
    (bans.deviceIds ?? []).forEach((id) => out.push({ type: 'device', id }));
    return out;
  }, [bans]);

  return (
    <div className="app">
      {showLoginModal && (
        <div className="admin-login-overlay" role="dialog" aria-modal="true" aria-labelledby="admin-login-title">
          <div className="admin-login-card">
            <div className="admin-login-brand">
              <span className="admin-login-brand-q">Q</span>
              <span className="admin-login-brand-bit">BIT</span>
              <span className="admin-login-brand-admin">Admin</span>
            </div>
            <h1 id="admin-login-title" className="admin-login-title">Sign in</h1>
            <p className="admin-login-subtitle">Use your admin credentials to continue.</p>
            <form
              className="admin-login-form"
              onSubmit={(e) => { e.preventDefault(); handleLogin(); }}
            >
              {loginError && (
                <div className="admin-login-error" role="alert">
                  {loginError}
                </div>
              )}
              <div className="admin-login-field">
                <label htmlFor="admin-username" className="admin-login-label">Username</label>
                <input
                  id="admin-username"
                  type="text"
                  className="admin-login-input"
                  value={loginUsername}
                  onChange={(e) => { setLoginUsername(e.target.value); setLoginError(null); }}
                  autoComplete="username"
                  maxLength={ADMIN_USERNAME_MAX_LEN}
                  placeholder="Username"
                  aria-invalid={!!loginError}
                />
              </div>
              <div className="admin-login-field">
                <label htmlFor="admin-password" className="admin-login-label">Password</label>
                <input
                  id="admin-password"
                  type="password"
                  className="admin-login-input"
                  value={loginPassword}
                  onChange={(e) => { setLoginPassword(e.target.value); setLoginError(null); }}
                  autoComplete="current-password"
                  minLength={ADMIN_PASSWORD_MIN_LEN}
                  maxLength={ADMIN_PASSWORD_MAX_LEN}
                  placeholder="Password"
                  aria-invalid={!!loginError}
                />
              </div>
              <button
                type="submit"
                className="admin-login-submit"
                disabled={
                  !loginUsername.trim() ||
                  loginPassword.length < ADMIN_PASSWORD_MIN_LEN ||
                  loginPassword.length > ADMIN_PASSWORD_MAX_LEN
                }
              >
                Sign in
              </button>
            </form>
          </div>
        </div>
      )}

      <nav className="navbar">
        <div className="navbar-brand">
          <span className="brand-q">Q</span>
          <span className="brand-bit">BIT</span>
          <span className="admin-badge">Admin</span>
        </div>
        {auth && (
          <div className="navbar-actions">
            <button
              type="button"
              className="btn btn-ghost navbar-refresh-btn"
              onClick={() => refresh(true)}
              disabled={loading}
              title="Refresh all"
              aria-label="Refresh all"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={handleLogout}
            >
              Logout
            </button>
          </div>
        )}
      </nav>

      <main className="main">
        {auth === null && (
          <div className="section" style={{ color: 'var(--text-muted)', textAlign: 'center' }}>
            Loading...
          </div>
        )}
        {error && (
          <div className="section" style={{ color: 'var(--red-light)' }}>
            {error}
          </div>
        )}

        <section className="section">
          <h2 className="section-title">Ban user or IP</h2>
          <div className="ban-form">
            <input
              type="text"
              placeholder="User ID"
              value={banUserId}
              onChange={(e) => setBanUserId(e.target.value)}
            />
            <input
              type="text"
              placeholder="IP address"
              value={banIp}
              onChange={(e) => setBanIp(e.target.value)}
            />
            <button className="btn btn-danger" onClick={handleBan} disabled={loading}>
              Add ban
            </button>
          </div>
        </section>

        <section className="section">
          <div className="section-header-row">
            <button className="section-toggle" onClick={() => toggle('bans')}>
              <span className={`section-chevron${collapsed.bans ? '' : ' section-chevron-open'}`}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </span>
              <h2 className="section-title">
                Current bans (
                {(bans.userIds?.length ?? 0) + (bans.ips?.length ?? 0) + (bans.deviceIds?.length ?? 0)}
                )
              </h2>
            </button>
          </div>
          {!collapsed.bans && (
            <div className="admin-table-wrap admin-bans-list">
              <VirtualList
                itemCount={bansFlat.length}
                itemHeight={banListRowHeight}
                containerHeight={VIRTUAL_CONTAINER_HEIGHT}
                empty={<div className="empty-msg">No bans</div>}
              >
                {(i) => {
                  const entry = bansFlat[i];
                  if (entry.type === 'user') {
                    const u = userMap.get(entry.id);
                    return (
                      <div className="ban-item">
                        <span>
                          User: {u ? <strong>{u.displayName}</strong> : null}
                          {' '}<code>{entry.id}</code>
                        </span>
                        <button className="btn btn-ghost" onClick={() => handleUnbanUser(entry.id)}>Unban</button>
                      </div>
                    );
                  }
                  if (entry.type === 'ip') {
                    return (
                      <div className="ban-item">
                        <span>IP: <code>{entry.id}</code></span>
                        <button className="btn btn-ghost" onClick={() => handleUnbanIp(entry.id)}>Unban</button>
                      </div>
                    );
                  }
                  const dName = deviceNameMap.get(entry.id);
                  return (
                    <div className="ban-item">
                      <span>
                        Device: {dName ? <strong>{dName}</strong> : null}
                        {' '}<code>{entry.id}</code>
                      </span>
                      <button className="btn btn-ghost" onClick={() => handleUnbanDevice(entry.id)}>Unban</button>
                    </div>
                  );
                }}
              </VirtualList>
            </div>
          )}
        </section>

        <section className="section">
          <div className="section-header-row">
            <button className="section-toggle" onClick={() => toggle('users')}>
              <span className={`section-chevron${collapsed.users ? '' : ' section-chevron-open'}`}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </span>
              <h2 className="section-title">Users ({users.length})</h2>
            </button>
            <div className="section-actions">
              {loading && <span className="admin-loading">Updating...</span>}
            </div>
          </div>
          {!collapsed.users && (
            <VirtualList
              itemCount={users.length}
              itemHeight={listRowHeight}
              containerHeight={VIRTUAL_CONTAINER_HEIGHT}
              empty={!loading ? <div className="empty-msg">No users yet</div> : undefined}
            >
              {(i) => {
                const u = users[i];
                return (
                  <div className="admin-user-row">
                    {u.avatar ? (
                      <img
                        src={u.avatar}
                        alt=""
                        className="admin-avatar"
                        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                      />
                    ) : (
                      <span className="admin-avatar-placeholder" />
                    )}
                    <div className="admin-user-info">
                      <span className="admin-user-name">{u.displayName}</span>
                      <span className="admin-user-email">{u.email}</span>
                      <span className="admin-user-meta">
                        {u.status === 'online' ? (
                          <span className="admin-status-online">Online</span>
                        ) : (
                          <span className="admin-status-offline">Offline</span>
                        )}
                        {' · Last seen '}
                        {new Date(u.lastSeen).toLocaleString()}
                      </span>
                    </div>
                    <div className="admin-user-actions">
                      <button
                        className="btn btn-danger"
                        onClick={() => handleBanSessionUser(u.userId)}
                      >
                        Ban user
                      </button>
                      <button
                        className="btn btn-ghost"
                        onClick={() => handleDeleteUser(u.userId)}
                        title="Delete user record"
                      >
                        Delete user
                      </button>
                    </div>
                  </div>
                );
              }}
            </VirtualList>
          )}
        </section>

        <section className="section">
          <div className="section-header-row">
            <button className="section-toggle" onClick={() => toggle('claims')}>
              <span className={`section-chevron${collapsed.claims ? '' : ' section-chevron-open'}`}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </span>
              <h2 className="section-title">Claims ({claims.length})</h2>
            </button>
            <div className="section-actions">
              {loading && <span className="admin-loading">Updating...</span>}
            </div>
          </div>
          {!collapsed.claims && (
            <VirtualList
              itemCount={claims.length}
              itemHeight={listRowHeight}
              containerHeight={VIRTUAL_CONTAINER_HEIGHT}
              empty={!loading ? <div className="empty-msg">No claims</div> : undefined}
            >
              {(i) => {
                const c = claims[i];
                return (
                  <div className="admin-claim-row">
                    {c.userAvatar ? (
                      <img
                        src={c.userAvatar}
                        alt=""
                        className="admin-avatar"
                        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                      />
                    ) : (
                      <span className="admin-avatar-placeholder" />
                    )}
                    <div className="admin-claim-info">
                      <span className="admin-claim-device">{c.deviceName || c.deviceId}</span>
                      <span className="admin-claim-user">Claimed by {c.userName}</span>
                      <span className="admin-claim-meta">{new Date(c.claimedAt).toLocaleString()}</span>
                    </div>
                    <div className="admin-claim-actions">
                      <button
                        className="btn btn-ghost"
                        onClick={() => handleUnclaim(c.deviceId)}
                        title="Remove claim"
                      >
                        Unclaim
                      </button>
                    </div>
                  </div>
                );
              }}
            </VirtualList>
          )}
        </section>

        <section className="section">
          <div className="section-header-row">
            <button className="section-toggle" onClick={() => toggle('sessions')}>
              <span className={`section-chevron${collapsed.sessions ? '' : ' section-chevron-open'}`}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </span>
              <h2 className="section-title">Online sessions ({sessions.length})</h2>
            </button>
            <div className="section-actions">
              {loading && <span className="admin-loading">Updating...</span>}
            </div>
          </div>
          {!collapsed.sessions && (
            <div className="admin-table-wrap admin-table-fixed" style={{ maxHeight: VIRTUAL_CONTAINER_HEIGHT, overflow: 'auto' }}>
              <table className="admin-table">
                <thead>
                  <tr>
                    <th></th>
                    <th>Name</th>
                    <th>Email</th>
                    <th>User ID</th>
                    <th>IP</th>
                    <th>Connected</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.length === 0 && !loading && (
                    <tr>
                      <td colSpan={7} className="empty-msg">No sessions</td>
                    </tr>
                  )}
                  {sessions.map((s) => (
                    <tr key={s.socketId}>
                      <td>
                        {s.avatar ? (
                          <img
                            src={s.avatar}
                            alt=""
                            className="admin-table-avatar"
                            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                          />
                        ) : (
                          <span className="admin-avatar-placeholder admin-table-avatar-placeholder" />
                        )}
                      </td>
                      <td>{s.displayName}</td>
                      <td>{s.email}</td>
                      <td><code style={{ fontSize: '0.85em' }}>{s.userId}</code></td>
                      <td>{s.ip}</td>
                      <td>{new Date(s.connectedAt).toLocaleString()}</td>
                      <td>
                        <div className="admin-action-btns">
                          <button
                            className="btn btn-danger"
                            onClick={() => handleBanSessionUser(s.userId)}
                          >
                            Ban user
                          </button>
                          <button className="btn btn-ghost" onClick={() => handleBanSessionIp(s.ip)}>
                            Ban IP
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="section">
          <div className="section-header-row">
            <button className="section-toggle" onClick={() => toggle('devices')}>
              <span className={`section-chevron${collapsed.devices ? '' : ' section-chevron-open'}`}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </span>
              <h2 className="section-title">Devices ({devices.length})</h2>
            </button>
            <div className="section-actions">
              {loading && <span className="admin-loading">Updating...</span>}
            </div>
          </div>
          {!collapsed.devices && (
            <>
              <div className="admin-devices-toolbar">
                <div className="admin-sort-group" role="group" aria-label="Sort devices">
                  <span className="admin-sort-label">Sort by</span>
                  <div className="admin-sort-pills">
                    {(
                      [
                        ['id', 'ID'],
                        ['name', 'Name'],
                        ['ip', 'Local IP'],
                        ['publicIp', 'Public IP'],
                        ['version', 'Version'],
                        ['lastSeen', 'Last seen'],
                      ] as const
                    ).map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        className={`admin-pill${deviceSortBy === key ? ' admin-pill-active' : ''}`}
                        onClick={() => setDeviceSortBy(key)}
                        aria-pressed={deviceSortBy === key}
                        aria-label={`Sort by ${label}`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="admin-sort-order">
                    <button
                      type="button"
                      className={`admin-order-btn${deviceSortOrder === 'asc' ? ' admin-order-btn-active' : ''}`}
                      onClick={() => setDeviceSortOrder('asc')}
                      aria-pressed={deviceSortOrder === 'asc'}
                      title="Ascending"
                      aria-label="Ascending order"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M18 15l-6-6-6 6" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className={`admin-order-btn${deviceSortOrder === 'desc' ? ' admin-order-btn-active' : ''}`}
                      onClick={() => setDeviceSortOrder('desc')}
                      aria-pressed={deviceSortOrder === 'desc'}
                      title="Descending"
                      aria-label="Descending order"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M6 9l6 6 6-6" />
                      </svg>
                    </button>
                  </div>
                </div>
                {selectedDeviceIds.size > 0 && (
                  <button
                    type="button"
                    className="btn btn-danger admin-toolbar-action"
                    onClick={handleDeleteSelectedDevices}
                  >
                    Delete selected ({selectedDeviceIds.size})
                  </button>
                )}
              </div>
              <div className="admin-table-wrap admin-table-fixed" style={{ maxHeight: VIRTUAL_CONTAINER_HEIGHT, overflow: 'auto' }}>
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th className="admin-th-checkbox">
                        <label className="admin-checkbox-wrap">
                          <input
                            type="checkbox"
                            checked={sortedDevices.length > 0 && selectedDeviceIds.size === sortedDevices.length}
                            onChange={toggleSelectAllDevices}
                            aria-label="Select all devices"
                            className="admin-checkbox"
                          />
                          <span className="admin-checkbox-box" aria-hidden="true" />
                        </label>
                      </th>
                      <th>ID</th>
                      <th>Name</th>
                      <th>Status</th>
                      <th>Local IP</th>
                      <th>Public IP</th>
                      <th>Version</th>
                      <th>Last seen</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedDevices.length === 0 && !loading && (
                      <tr>
                        <td colSpan={9} className="empty-msg">No devices</td>
                      </tr>
                    )}
                    {sortedDevices.map((d) => (
                      <tr key={d.id}>
                        <td className="admin-td-checkbox">
                          <label className="admin-checkbox-wrap">
                            <input
                              type="checkbox"
                              checked={selectedDeviceIds.has(d.id)}
                              onChange={() => toggleDeviceSelection(d.id)}
                              aria-label={`Select ${d.name}`}
                              className="admin-checkbox"
                            />
                            <span className="admin-checkbox-box" aria-hidden="true" />
                          </label>
                        </td>
                        <td><code style={{ fontSize: '0.85em' }}>{d.id}</code></td>
                        <td>{d.name}</td>
                        <td>
                          {d.status === 'online' ? (
                            <span className="admin-status-online">Online</span>
                          ) : (
                            <span className="admin-status-offline">Offline</span>
                          )}
                        </td>
                        <td>{d.ip}</td>
                        <td>{d.publicIp || '-'}</td>
                        <td>{d.version}</td>
                        <td>{new Date(d.lastSeen).toLocaleString()}</td>
                        <td>
                          <button className="btn btn-danger" onClick={() => handleBanDevice(d.id)}>
                            Ban device
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
