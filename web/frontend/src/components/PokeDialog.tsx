import { useState, useCallback } from 'react';
import type { Device, User } from '../types';

interface Props {
  device: Device;
  user: User | null;
  onPoke: (targetId: string, text: string, bitmapData?: BitmapPayload) => void;
  onClaim: (device: Device) => void;
  onClose: () => void;
  isLoggedIn: boolean;
  apiUrl: string;
}

export interface BitmapPayload {
  senderBitmap: string;
  senderBitmapWidth: number;
  textBitmap: string;
  textBitmapWidth: number;
}

const QUICK_MESSAGES = [
  { label: 'Hi!', text: 'Hi!' },
  { label: 'LOL', text: 'LOL' },
  { label: '<3', text: '<3' },
  { label: 'Poke!', text: 'Poke!' },
  { label: ':)', text: ':)' },
  { label: 'GG', text: 'GG' },
];

// Render text to a 1-bit monochrome bitmap suitable for SSD1306 OLED display.
// Returns { bitmap: base64, width, height } where height is padded to multiple of 8.
// The bitmap is in SSD1306 page format: column-major, 8 vertical pixels per byte.
function renderTextToBitmap(
  text: string,
  fontSize: number = 14
): { bitmap: string; width: number; height: number } {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;

  // Measure text first
  ctx.font = `bold ${fontSize}px sans-serif`;
  const metrics = ctx.measureText(text);
  const textWidth = Math.ceil(metrics.width);
  const textHeight = fontSize + 4; // add small padding

  // Round height up to multiple of 8 for SSD1306 page alignment
  const height = Math.ceil(textHeight / 8) * 8;
  const width = Math.max(textWidth + 2, 1); // minimum 1px, 1px padding each side

  canvas.width = width;
  canvas.height = height;

  // Black background
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);

  // White text
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textBaseline = 'top';
  ctx.fillText(text, 1, 2);

  // Convert to 1-bit bitmap in SSD1306 page format
  const imageData = ctx.getImageData(0, 0, width, height);
  const pages = height / 8;
  const bytes = new Uint8Array(width * pages);

  for (let x = 0; x < width; x++) {
    for (let page = 0; page < pages; page++) {
      let byte = 0;
      for (let bit = 0; bit < 8; bit++) {
        const y = page * 8 + bit;
        if (y < height) {
          const idx = (y * width + x) * 4;
          // Threshold: pixel is "on" if any RGB channel > 127
          if (imageData.data[idx] > 127) {
            byte |= (1 << bit);
          }
        }
      }
      bytes[page * width + x] = byte;
    }
  }

  // Convert to base64
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const bitmap = btoa(binary);

  return { bitmap, width, height };
}

export default function PokeDialog({
  device,
  user,
  onPoke,
  onClaim,
  onClose,
  isLoggedIn,
  apiUrl,
}: Props) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  const send = useCallback(async (msg: string) => {
    if (!msg.trim() || sending) return;
    setSending(true);

    // Render both sender name and message text to bitmaps
    const senderName = user?.displayName || 'Anonymous';
    const senderResult = renderTextToBitmap(senderName, 13);
    const textResult = renderTextToBitmap(msg.trim(), 14);

    const bitmapData: BitmapPayload = {
      senderBitmap: senderResult.bitmap,
      senderBitmapWidth: senderResult.width,
      textBitmap: textResult.bitmap,
      textBitmapWidth: textResult.width,
    };

    await onPoke(device.id, msg.trim(), bitmapData);
    setSending(false);
  }, [sending, user, device.id, onPoke]);

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
              maxLength={25}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') send(text);
              }}
              autoFocus
            />
            <div className="poke-char-count">
              {text.length}/25
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

            {!device.claimedBy && (
              <button
                className="btn-claim-link"
                onClick={() => onClaim(device)}
              >
                Claim this device
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
