import { useState, useEffect, useRef, useCallback } from 'react';
import QgifPreview from './QgifPreview';
import type { User } from '../types';

interface LibraryItem {
  id: string;
  filename: string;
  uploader: string;
  uploaderId: string;
  uploadedAt: string;
  size: number;
  frameCount: number;
}

interface Props {
  user: User | null;
  apiUrl: string;
}

function formatSize(b: number): string {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export default function LibraryPage({ user, apiUrl }: Props) {
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchItems = useCallback(async () => {
    try {
      const res = await fetch(`${apiUrl}/api/library`);
      if (res.ok) {
        const data = await res.json();
        setItems(data);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [apiUrl]);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  const uploadFile = async (file: File) => {
    if (!file.name.endsWith('.qgif')) {
      setUploadMsg({ text: 'Only .qgif files are accepted', ok: false });
      return;
    }

    setUploading(true);
    setUploadMsg(null);

    try {
      const fd = new FormData();
      fd.append('file', file);

      const res = await fetch(`${apiUrl}/api/library/upload`, {
        method: 'POST',
        credentials: 'include',
        body: fd,
      });

      const data = await res.json();

      if (res.ok) {
        setUploadMsg({ text: `Uploaded ${file.name}`, ok: true });
        await fetchItems();
      } else {
        setUploadMsg({ text: data.error || 'Upload failed', ok: false });
      }
    } catch {
      setUploadMsg({ text: 'Network error', ok: false });
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (id: string, filename: string) => {
    if (!confirm(`Delete ${filename}?`)) return;

    try {
      const res = await fetch(`${apiUrl}/api/library/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (res.ok) {
        await fetchItems();
      } else {
        const data = await res.json();
        alert(data.error || 'Delete failed');
      }
    } catch {
      alert('Network error');
    }
  };

  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    uploadFile(files[0]);
  };

  return (
    <div className="library-page">
      <div className="library-header">
        <div>
          <span className="library-title">
            QGIF Library
            {items.length > 0 && (
              <span className="library-count">{items.length} files</span>
            )}
          </span>
        </div>
      </div>

      {user ? (
        <div
          className={`library-upload${dragging ? ' drag' : ''}`}
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            handleFiles(e.dataTransfer.files);
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".qgif"
            onChange={(e) => {
              handleFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <span className="library-upload-icon">&#8682;</span>
          {uploading ? 'Uploading...' : 'Drop .qgif file here or click to upload'}
          {uploadMsg && (
            <div className={`library-upload-msg ${uploadMsg.ok ? 'ok' : 'error'}`}>
              {uploadMsg.text}
            </div>
          )}
        </div>
      ) : (
        <div className="library-login-hint">
          Log in to upload .qgif files to the community library.
        </div>
      )}

      {loading ? (
        <div className="library-empty">Loading...</div>
      ) : items.length === 0 ? (
        <div className="library-empty">
          No .qgif files yet. Be the first to upload one!
        </div>
      ) : (
        <div className="library-grid">
          {items.map((item) => (
            <div className="library-card" key={item.id}>
              <div className="library-card-preview">
                <QgifPreview src={`${apiUrl}/api/library/${item.id}/raw`} />
              </div>
              <div className="library-card-info">
                <div className="library-card-name">{item.filename}</div>
                <div className="library-card-meta">
                  {item.frameCount} frames &middot; {formatSize(item.size)}
                </div>
                <div className="library-card-meta">
                  by {item.uploader} &middot; {formatDate(item.uploadedAt)}
                </div>
                <div className="library-card-actions">
                  <a
                    className="btn-download"
                    href={`${apiUrl}/api/library/${item.id}/download`}
                  >
                    Download
                  </a>
                  {user && user.id === item.uploaderId && (
                    <button
                      className="btn-delete-lib"
                      onClick={() => handleDelete(item.id, item.filename)}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
