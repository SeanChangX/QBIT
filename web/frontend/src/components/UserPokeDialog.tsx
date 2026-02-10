import { useState, useCallback } from 'react';
import type { OnlineUser } from '../types';

interface Props {
  target: OnlineUser;
  onPoke: (targetUserId: string, text: string) => Promise<void>;
  onClose: () => void;
}

const QUICK_MESSAGES = [
  { label: 'Hi!', text: 'Hi!' },
  { label: 'Poke!', text: 'Poke!' },
  { label: ':)', text: ':)' },
];

export default function UserPokeDialog({ target, onPoke, onClose }: Props) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

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
    <div className="poke-overlay" onClick={onClose}>
      <div className="poke-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="poke-header">
          <span className="poke-title">Poke: {target.displayName}</span>
          <button className="poke-close" onClick={onClose}>
            &times;
          </button>
        </div>
        <input
          className="poke-input"
          type="text"
          placeholder="Type a message..."
          maxLength={100}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send(text);
          }}
        />
        <div className="poke-char-count">
          {text.length}/100
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
      </div>
    </div>
  );
}
