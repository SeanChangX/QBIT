import { useState } from 'react';
import type { Device } from '../types';

interface Props {
  device: Device;
  apiUrl: string;
  onClose: () => void;
  onClaimed: () => void;
}

export default function ClaimDialog({ device, apiUrl, onClose, onClaimed }: Props) {
  const [deviceIdFull, setDeviceIdFull] = useState('');
  const [status, setStatus] = useState<'idle' | 'pending' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const handleSubmit = async () => {
    if (!deviceIdFull.trim()) return;

    setStatus('pending');
    setErrorMsg('');

    try {
      const res = await fetch(`${apiUrl}/api/claim`, {
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
        // Request sent to device, waiting for physical confirmation
        setStatus('pending');
        // Poll or wait -- the device list update will come via Socket.io
        // Show waiting message for 30 seconds
        setTimeout(() => {
          onClaimed();
          onClose();
        }, 30_000);
      } else {
        setStatus('error');
        setErrorMsg(data.error || 'Claim failed');
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
          <span className="poke-title">Claim: {device.name}</span>
          <button className="poke-close" onClick={onClose}>
            &times;
          </button>
        </div>

        {status === 'pending' ? (
          <div className="claim-pending">
            <div className="claim-pending-icon">&#8987;</div>
            <p>Waiting for confirmation on the QBIT device...</p>
            <p className="claim-pending-hint">
              Long-press the touch button on your QBIT to confirm.
            </p>
          </div>
        ) : (
          <>
            <p className="claim-description">
              Enter the full 12-character device ID to claim this QBIT.
              The device will prompt for physical confirmation.
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
              Send Claim Request
            </button>
          </>
        )}
      </div>
    </div>
  );
}
