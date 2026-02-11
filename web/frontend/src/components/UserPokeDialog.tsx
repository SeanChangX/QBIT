import { useState, useCallback, useRef, useEffect } from 'react';
import type { OnlineUser } from '../types';

interface Props {
  target: OnlineUser;
  onPoke: (targetUserId: string, text: string) => Promise<void>;
  onClose: () => void;
  isLoggedIn: boolean;
  apiUrl: string;
}

const QUICK_MESSAGES = [
  { label: 'Hi!', text: 'Hi!' },
  { label: 'LOL', text: 'LOL' },
  { label: '<3', text: '<3' },
  { label: 'Poke!', text: 'Poke!' },
  { label: ':)', text: ':)' },
  { label: 'GG', text: 'GG' },
];

const MAX_LENGTH = 25;

export default function UserPokeDialog({ target, onPoke, onClose, isLoggedIn, apiUrl }: Props) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  // Guard: ignore overlay clicks for a short period after opening
  const readyRef = useRef(false);
  const pointerOnOverlayRef = useRef(false);
  useEffect(() => {
    const timer = setTimeout(() => { readyRef.current = true; }, 300);
    return () => clearTimeout(timer);
  }, []);

  const handleOverlayPointerDown = useCallback((e: React.PointerEvent) => {
    pointerOnOverlayRef.current = e.target === e.currentTarget;
  }, []);

  const handleOverlayClick = useCallback((e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return;
    if (!readyRef.current) return;
    if (!pointerOnOverlayRef.current) return;
    onClose();
  }, [onClose]);

  const send = useCallback(
    async (msg: string) => {
      if (!msg.trim() || sending) return;
      setSending(true);
      await onPoke(target.userId, msg.trim());
      setSending(false);
      onClose();
    },
    [sending, target.userId, onPoke, onClose]
  );

  return (
    <div className="poke-overlay" onPointerDown={handleOverlayPointerDown} onClick={handleOverlayClick}>
      <div className="poke-dialog poke-dialog-offset">
        <div className="poke-header">
          <span className="poke-title">Poke: {target.displayName}</span>
          <button className="poke-close" onClick={onClose}>
            &times;
          </button>
        </div>
        {!isLoggedIn ? (
          <div className="poke-login-msg">
            <a href={`${apiUrl}/auth/google`}>Login</a> to send a poke.
          </div>
        ) : (
          <>
            <input
              className="poke-input"
              type="text"
              placeholder="Type a message..."
              maxLength={MAX_LENGTH}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') send(text);
              }}
            />
            <div className="poke-char-count">
              {text.length}/{MAX_LENGTH}
            </div>
            <div className="poke-quick">
              {QUICK_MESSAGES.map((q) => (
                <button
                  key={q.text}
                  className="poke-quick-btn"
                  onClick={() => send(q.text)}
                  disabled={sending}
                >
                  {q.label}
                </button>
              ))}
            </div>
            <button
              className="btn btn-poke"
              onClick={() => send(text)}
              disabled={!text.trim() || sending}
            >
              {sending ? 'Sending...' : 'Send Poke'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
