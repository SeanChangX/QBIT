import { useState, useEffect, useCallback, useRef, useMemo } from 'react';

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
  connectedAt: string;
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

  // Collapsible section state (all collapsed by default except sessions)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({
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
          <h2 className="section-title">Current bans</h2>
          <div className="admin-table-wrap">
            <div className="bans-list">
              {bans.userIds.length === 0 && bans.ips.length === 0 && (bans.deviceIds?.length ?? 0) === 0 && (
                <div className="empty-msg">No bans</div>
              )}
              {(bans.userIds ?? []).map((id) => {
                const u = userMap.get(id);
                return (
                  <div key={`u-${id}`} className="ban-item">
                    <span>
                      User: {u ? <strong>{u.displayName}</strong> : null}
                      {' '}<code>{id}</code>
                    </span>
                    <button className="btn btn-ghost" onClick={() => handleUnbanUser(id)}>Unban</button>
                  </div>
                );
              })}
              {(bans.ips ?? []).map((ip) => (
                <div key={`i-${ip}`} className="ban-item">
                  <span>IP: <code>{ip}</code></span>
                  <button className="btn btn-ghost" onClick={() => handleUnbanIp(ip)}>Unban</button>
                </div>
              ))}
              {(bans.deviceIds ?? []).map((id) => {
                const dName = deviceNameMap.get(id);
                return (
                  <div key={`d-${id}`} className="ban-item">
                    <span>
                      Device: {dName ? <strong>{dName}</strong> : null}
                      {' '}<code>{id}</code>
                    </span>
                    <button className="btn btn-ghost" onClick={() => handleUnbanDevice(id)}>Unban</button>
                  </div>
                );
              })}
            </div>
          </div>
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
            <div className="admin-scroll-list">
              {users.length === 0 && !loading && (
                <div className="empty-msg">No users yet</div>
              )}
              {users.map((u) => (
                <div key={u.userId} className="admin-user-row">
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
                  </div>
                </div>
              ))}
            </div>
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
            <div className="admin-scroll-list">
              {claims.length === 0 && !loading && (
                <div className="empty-msg">No claims</div>
              )}
              {claims.map((c) => (
                <div key={c.deviceId} className="admin-claim-row">
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
                </div>
              ))}
            </div>
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
            <div className="admin-table-wrap admin-table-fixed">
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
            <div className="admin-table-wrap admin-table-fixed">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Name</th>
                    <th>Local IP</th>
                    <th>Public IP</th>
                    <th>Version</th>
                    <th>Connected</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {devices.length === 0 && !loading && (
                    <tr>
                      <td colSpan={7} className="empty-msg">No devices</td>
                    </tr>
                  )}
                  {devices.map((d) => (
                    <tr key={d.id}>
                      <td><code style={{ fontSize: '0.85em' }}>{d.id}</code></td>
                      <td>{d.name}</td>
                      <td>{d.ip}</td>
                      <td>{d.publicIp || '-'}</td>
                      <td>{d.version}</td>
                      <td>{new Date(d.connectedAt).toLocaleString()}</td>
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
          )}
        </section>
      </main>
    </div>
  );
}
