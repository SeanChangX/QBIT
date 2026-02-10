import { useState, useEffect, useCallback } from 'react';

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
}

function load<T>(url: string): Promise<T> {
  return fetch(url).then((r) => {
    if (!r.ok) throw new Error(r.statusText);
    return r.json();
  });
}

function post(url: string, body: object): Promise<void> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => {
    if (!r.ok) throw new Error(r.statusText);
  });
}

function del(url: string, body: object): Promise<void> {
  return fetch(url, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => {
    if (!r.ok) throw new Error(r.statusText);
  });
}

export default function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [bans, setBans] = useState<BannedList>({ userIds: [], ips: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [banUserId, setBanUserId] = useState('');
  const [banIp, setBanIp] = useState('');

  const refresh = useCallback(async () => {
    setError(null);
    setLoading(true);
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
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 10000);
    return () => clearInterval(t);
  }, [refresh]);

  const handleBan = useCallback(async () => {
    if (!banUserId.trim() && !banIp.trim()) return;
    try {
      await post('/api/ban', { userId: banUserId.trim() || undefined, ip: banIp.trim() || undefined });
      setBanUserId('');
      setBanIp('');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ban failed');
    }
  }, [banUserId, banIp, refresh]);

  const handleUnbanUser = useCallback(
    async (userId: string) => {
      try {
        await del('/api/ban', { userId });
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Unban failed');
      }
    },
    [refresh]
  );

  const handleUnbanIp = useCallback(
    async (ip: string) => {
      try {
        await del('/api/ban', { ip });
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Unban failed');
      }
    },
    [refresh]
  );

  const handleBanSessionUser = useCallback(
    async (userId: string) => {
      try {
        await post('/api/ban', { userId });
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Ban failed');
      }
    },
    [refresh]
  );

  const handleBanSessionIp = useCallback(
    async (ip: string) => {
      try {
        await post('/api/ban', { ip });
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Ban failed');
      }
    },
    [refresh]
  );

  return (
    <div className="app">
      <nav className="navbar">
        <div className="navbar-brand">
          <span className="brand-q">Q</span>
          <span className="brand-bit">BIT</span>
          <span className="admin-badge">Admin</span>
        </div>
      </nav>

      <main className="main">
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
              {bans.userIds.length === 0 && bans.ips.length === 0 && (
                <div className="empty-msg">No bans</div>
              )}
              {bans.userIds.map((id) => (
                <div key={`u-${id}`} className="ban-item">
                  <span>User: <code>{id}</code></span>
                  <button className="btn btn-ghost" onClick={() => handleUnbanUser(id)}>Unban</button>
                </div>
              ))}
              {bans.ips.map((ip) => (
                <div key={`i-${ip}`} className="ban-item">
                  <span>IP: <code>{ip}</code></span>
                  <button className="btn btn-ghost" onClick={() => handleUnbanIp(ip)}>Unban</button>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="section">
          <h2 className="section-title">Online sessions (users)</h2>
          <div className="admin-table-wrap">
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
            <div className="refresh-row">
              <button className="btn btn-ghost" onClick={refresh} disabled={loading}>
                {loading ? 'Loading...' : 'Refresh'}
              </button>
            </div>
          </div>
        </section>

        <section className="section">
          <h2 className="section-title">Devices (QBIT hardware)</h2>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Name</th>
                  <th>Local IP</th>
                  <th>Public IP</th>
                  <th>Version</th>
                  <th>Connected</th>
                </tr>
              </thead>
              <tbody>
                {devices.length === 0 && !loading && (
                  <tr>
                    <td colSpan={6} className="empty-msg">No devices</td>
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
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="refresh-row">
              <button className="btn btn-ghost" onClick={refresh} disabled={loading}>
                {loading ? 'Loading...' : 'Refresh'}
              </button>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
