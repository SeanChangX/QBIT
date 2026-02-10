import { useState, useEffect, useCallback, useRef } from 'react';

interface Session {
  socketId: string;
  userId: string;
  displayName: string;
  email: string;
  ip: string;
  connectedAt: string;
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
      const [s, d, b] = await Promise.all([
        load<Session[]>('/api/sessions'),
        load<Device[]>('/api/devices'),
        load<BannedList>('/api/bans'),
      ]);
      setSessions(s);
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
          <button
            type="button"
            className="btn btn-ghost"
            onClick={handleLogout}
          >
            Logout
          </button>
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
              {(bans.userIds ?? []).map((id) => (
                <div key={`u-${id}`} className="ban-item">
                  <span>User: <code>{id}</code></span>
                  <button className="btn btn-ghost" onClick={() => handleUnbanUser(id)}>Unban</button>
                </div>
              ))}
              {(bans.ips ?? []).map((ip) => (
                <div key={`i-${ip}`} className="ban-item">
                  <span>IP: <code>{ip}</code></span>
                  <button className="btn btn-ghost" onClick={() => handleUnbanIp(ip)}>Unban</button>
                </div>
              ))}
              {(bans.deviceIds ?? []).map((id) => (
                <div key={`d-${id}`} className="ban-item">
                  <span>Device: <code>{id}</code></span>
                  <button className="btn btn-ghost" onClick={() => handleUnbanDevice(id)}>Unban</button>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="section">
          <div className="section-header-row">
            <h2 className="section-title">Online sessions (users)</h2>
            <div className="section-actions">
              {loading && <span className="admin-loading">Updating...</span>}
              <button className="btn btn-ghost" onClick={() => refresh(true)} disabled={loading}>
                Refresh
              </button>
            </div>
          </div>
          <div className="admin-table-wrap admin-table-fixed">
            <table className="admin-table">
              <thead>
                <tr>
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
                    <td colSpan={6} className="empty-msg">No sessions</td>
                  </tr>
                )}
                {sessions.map((s) => (
                  <tr key={s.socketId}>
                    <td>{s.displayName}</td>
                    <td>{s.email}</td>
                    <td><code style={{ fontSize: '0.85em' }}>{s.userId}</code></td>
                    <td>{s.ip}</td>
                    <td>{new Date(s.connectedAt).toLocaleString()}</td>
                    <td>
                      <button
                        className="btn btn-danger"
                        style={{ marginRight: 8 }}
                        onClick={() => handleBanSessionUser(s.userId)}
                      >
                        Ban user
                      </button>
                      <button className="btn btn-ghost" onClick={() => handleBanSessionIp(s.ip)}>
                        Ban IP
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="section">
          <div className="section-header-row">
            <h2 className="section-title">Devices (QBIT hardware)</h2>
            <div className="section-actions">
              {loading && <span className="admin-loading">Updating...</span>}
              <button className="btn btn-ghost" onClick={() => refresh(true)} disabled={loading}>
                Refresh
              </button>
            </div>
          </div>
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
        </section>
      </main>
    </div>
  );
}
