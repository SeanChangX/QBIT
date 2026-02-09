import { useState, useRef, useEffect } from 'react';
import type { User } from '../types';
import type { Page } from '../App';

interface Props {
  user: User | null;
  apiUrl: string;
  page: Page;
  setPage: (page: Page) => void;
}

const LOGIN_PROVIDERS = [
  {
    id: 'google',
    label: 'Google',
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18">
        <path
          fill="#4285F4"
          d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
        />
        <path
          fill="#34A853"
          d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        />
        <path
          fill="#FBBC05"
          d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        />
        <path
          fill="#EA4335"
          d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        />
      </svg>
    ),
    path: '/auth/google',
  },
];

const TABS: { id: Page; label: string }[] = [
  { id: 'network', label: 'Network' },
  { id: 'flash', label: 'Flash' },
  { id: 'library', label: 'Library' },
];

export default function Navbar({ user, apiUrl, page, setPage }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  return (
    <nav className="navbar">
      <div className="navbar-brand">
        <span className="brand-q">Q</span>
        <span className="brand-bit">BIT</span>
      </div>

      <div className="nav-tabs">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`nav-tab${page === tab.id ? ' active' : ''}`}
            onClick={() => setPage(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="navbar-user">
        {user ? (
          <>
            {user.avatar && (
              <img
                className="navbar-avatar"
                src={user.avatar}
                alt={user.displayName}
                referrerPolicy="no-referrer"
              />
            )}
            <span className="navbar-name">{user.displayName}</span>
            <a className="btn btn-logout" href={`${apiUrl}/auth/logout`}>
              <svg className="logout-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
              <span className="logout-text">Logout</span>
            </a>
          </>
        ) : (
          <div className="login-wrapper" ref={menuRef}>
            <button
              className="btn btn-login"
              onClick={() => setMenuOpen(!menuOpen)}
            >
              Login
            </button>
            {menuOpen && (
              <div className="login-menu">
                {LOGIN_PROVIDERS.map((p) => (
                  <a
                    key={p.id}
                    className="login-menu-item"
                    href={`${apiUrl}${p.path}`}
                  >
                    <span className="login-menu-icon">{p.icon}</span>
                    <span>{p.label}</span>
                  </a>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </nav>
  );
}
