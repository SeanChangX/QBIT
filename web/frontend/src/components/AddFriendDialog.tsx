import { useState } from 'react';
import type { Device } from '../types';

interface Props {
  device: Device;
  apiUrl: string;
  onClose: () => void;
}

export default function AddFriendDialog({ device, apiUrl, onClose }: Props) {
  const [deviceIdFull, setDeviceIdFull] = useState('');
  const [status, setStatus] = useState<'idle' | 'pending' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const handleSubmit = async () => {
    if (!deviceIdFull.trim()) return;

    setStatus('pending');
    setErrorMsg('');

    try {
      const res = await fetch(`${apiUrl}/api/friends/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          targetId: device.id,
          deviceIdFull: deviceIdFull.trim().toUpperCase(),
        }),
      });

      const data = await res.json();

      if (res.ok) {
        setStatus('pending');
      } else {
        setStatus('error');
        setErrorMsg(data.error || 'Friend request failed');
      }
    } catch {
      setStatus('error');
      setErrorMsg('Network error');
    }
  };

  return (
    <div className="poke-overlay" onClick={onClose}>
      <div className="poke-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="poke-header">
          <span className="poke-title">Add friend: {device.name}</span>
          <button className="poke-close" onClick={onClose}>
            &times;
          </button>
        </div>

        {status === 'pending' ? (
          <div className="claim-pending">
            <div className="claim-pending-icon">&#8987;</div>
            <p>Waiting for owner to confirm on device.</p>
            <p className="claim-pending-hint">Long-press the QBIT button to confirm.</p>
            <button type="button" className="btn btn-ghost" style={{ marginTop: 12 }} onClick={onClose}>
              Close
            </button>
          </div>
        ) : (
          <>
            <p className="claim-description">
              Enter the 12-character device ID. Owner confirms by long-press on the QBIT.
            </p>

            <input
              className="poke-input"
              type="text"
              placeholder="e.g. 30A0E710B894"
              maxLength={12}
              value={deviceIdFull}
              onChange={(e) => setDeviceIdFull(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSubmit();
              }}
              autoFocus
              style={{ fontFamily: 'monospace', letterSpacing: '0.1em' }}
            />

            {errorMsg && (
              <div className="claim-error">{errorMsg}</div>
            )}

            <button
              className="btn btn-poke"
              onClick={handleSubmit}
              disabled={deviceIdFull.trim().length !== 12}
            >
              Send Friend Request
            </button>
          </>
        )}
      </div>
    </div>
  );
}
