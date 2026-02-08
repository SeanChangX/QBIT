import { useState } from 'react';
import type { Device } from '../types';

interface Props {
  device: Device;
  onPoke: (targetId: string, text: string) => void;
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

export default function PokeDialog({
  device,
  onPoke,
  onClose,
  isLoggedIn,
  apiUrl,
}: Props) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  const send = async (msg: string) => {
    if (!msg.trim() || sending) return;
    setSending(true);
    await onPoke(device.id, msg.trim());
    setSending(false);
  };

  return (
    <div className="poke-overlay" onClick={onClose}>
      <div className="poke-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="poke-header">
          <span className="poke-title">Poke: {device.name}</span>
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
              maxLength={50}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') send(text);
              }}
              autoFocus
            />

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
