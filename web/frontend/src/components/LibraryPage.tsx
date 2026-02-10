import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import QgifPreview from './QgifPreview';
import type { User } from '../types';

const MAX_CONCURRENT_RAW = 8;
const rawQueue: Array<() => void> = [];
let rawInFlight = 0;

function runWithConcurrencyLimit<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const run = () => {
      rawInFlight++;
      fn()
        .then(resolve, reject)
        .finally(() => {
          rawInFlight--;
          if (rawQueue.length > 0) rawQueue.shift()!();
        });
    };
    if (rawInFlight < MAX_CONCURRENT_RAW) run();
    else rawQueue.push(run);
  });
}

function LazyLibraryPreview({ apiUrl, id }: { apiUrl: string; id: string }) {
  const [inView, setInView] = useState(false);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([e]) => {
        if (e?.isIntersecting) setInView(true);
      },
      { rootMargin: '100px', threshold: 0 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  useEffect(() => {
    if (!inView || blobUrl) return;
    const url = `${apiUrl}/api/library/${id}/raw`;
    let cancelled = false;
    runWithConcurrencyLimit(() => fetch(url).then((r) => r.arrayBuffer()))
      .then((buf) => {
        if (cancelled) return;
        const blob = new Blob([buf], { type: 'application/octet-stream' });
        setBlobUrl(URL.createObjectURL(blob));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [inView, apiUrl, id, blobUrl]);
  useEffect(() => {
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [blobUrl]);
  return (
    <div ref={ref} className="library-card-preview-inner">
      {blobUrl ? <QgifPreview src={blobUrl} /> : null}
    </div>
  );
}

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

type SortMode = 'newest' | 'oldest' | 'az' | 'za';

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

  // Filtering and sorting
  const [searchQuery, setSearchQuery] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('newest');

  // Multi-select
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [batchDownloading, setBatchDownloading] = useState(false);

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

  // Filtered and sorted items
  const displayItems = useMemo(() => {
    let filtered = items;

    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      filtered = filtered.filter((item) =>
        item.filename.toLowerCase().includes(q)
      );
    }

    const sorted = [...filtered];
    switch (sortMode) {
      case 'newest':
        sorted.sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime());
        break;
      case 'oldest':
        sorted.sort((a, b) => new Date(a.uploadedAt).getTime() - new Date(b.uploadedAt).getTime());
        break;
      case 'az':
        sorted.sort((a, b) => a.filename.localeCompare(b.filename));
        break;
      case 'za':
        sorted.sort((a, b) => b.filename.localeCompare(a.filename));
        break;
    }

    return sorted;
  }, [items, searchQuery, sortMode]);

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

  const uploadFiles = async (files: File[]) => {
    const qgifFiles = files.filter((f) => f.name.endsWith('.qgif'));
    if (qgifFiles.length === 0) {
      setUploadMsg({ text: 'Only .qgif files are accepted', ok: false });
      return;
    }

    setUploading(true);
    setUploadMsg(null);

    let successCount = 0;
    let failCount = 0;

    for (const file of qgifFiles) {
      try {
        const fd = new FormData();
        fd.append('file', file);

        const res = await fetch(`${apiUrl}/api/library/upload`, {
          method: 'POST',
          credentials: 'include',
          body: fd,
        });

        if (res.ok) {
          successCount++;
        } else {
          failCount++;
        }
      } catch {
        failCount++;
      }
    }

    await fetchItems();

    if (failCount === 0) {
      setUploadMsg({ text: `Uploaded ${successCount} file${successCount > 1 ? 's' : ''}`, ok: true });
    } else {
      setUploadMsg({
        text: `${successCount} uploaded, ${failCount} failed`,
        ok: successCount > 0,
      });
    }

    setUploading(false);
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
    if (files.length === 1) {
      uploadFile(files[0]);
    } else {
      uploadFiles(Array.from(files));
    }
  };

  // Multi-select handlers
  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const selectAll = () => {
    setSelectedIds(new Set(displayItems.map((item) => item.id)));
  };

  const deselectAll = () => {
    setSelectedIds(new Set());
  };

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
  };

  const handleBatchDelete = async () => {
    const count = selectedIds.size;
    if (count === 0) return;
    if (!confirm(`Delete ${count} selected file${count > 1 ? 's' : ''}?`)) return;

    setBatchDeleting(true);
    try {
      const res = await fetch(`${apiUrl}/api/library/batch`, {
        method: 'DELETE',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: Array.from(selectedIds) }),
      });

      if (res.ok) {
        const data = await res.json();
        setSelectedIds(new Set());
        await fetchItems();
        if (data.failed > 0) {
          alert(`${data.deleted} deleted, ${data.failed} failed (not owned by you)`);
        }
      } else {
        const data = await res.json();
        alert(data.error || 'Batch delete failed');
      }
    } catch {
      alert('Network error');
    } finally {
      setBatchDeleting(false);
    }
  };

  const handleBatchDownload = async () => {
    if (selectedIds.size === 0) return;

    setBatchDownloading(true);
    try {
      const res = await fetch(`${apiUrl}/api/library/batch-download`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: Array.from(selectedIds) }),
      });

      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'qgif-library.zip';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } else {
        alert('Download failed');
      }
    } catch {
      alert('Network error');
    } finally {
      setBatchDownloading(false);
    }
  };

  // Count how many selected items are owned by current user
  const ownedSelectedCount = useMemo(() => {
    if (!user) return 0;
    return items.filter((i) => selectedIds.has(i.id) && i.uploaderId === user.id).length;
  }, [items, selectedIds, user]);

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
        {user && items.length > 0 && (
          <div className="library-header-actions">
            {selectMode ? (
              <button className="btn-lib-action" onClick={exitSelectMode}>
                Cancel
              </button>
            ) : (
              <button className="btn-lib-action" onClick={() => setSelectMode(true)}>
                Select
              </button>
            )}
          </div>
        )}
      </div>

      {/* Toolbar: search + sort */}
      {items.length > 0 && (
        <div className="library-toolbar">
          <input
            className="library-search"
            type="text"
            placeholder="Search by name..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <select
            className="library-sort"
            value={sortMode}
            onChange={(e) => setSortMode(e.target.value as SortMode)}
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="az">Name A-Z</option>
            <option value="za">Name Z-A</option>
          </select>
        </div>
      )}

      {/* Selection toolbar */}
      {selectMode && (
        <div className="library-selection-bar">
          <span className="library-selection-count">
            {selectedIds.size} selected
          </span>
          <button className="btn-lib-action btn-sm" onClick={selectAll}>
            All
          </button>
          <button className="btn-lib-action btn-sm" onClick={deselectAll}>
            None
          </button>
          <div className="library-selection-spacer" />
          {selectedIds.size > 0 && (
            <>
              <button
                className="btn-lib-action btn-sm"
                onClick={handleBatchDownload}
                disabled={batchDownloading}
              >
                {batchDownloading ? 'Zipping...' : `Download (${selectedIds.size})`}
              </button>
              {ownedSelectedCount > 0 && (
                <button
                  className="btn-lib-action btn-sm btn-danger"
                  onClick={handleBatchDelete}
                  disabled={batchDeleting}
                >
                  {batchDeleting ? 'Deleting...' : `Delete (${ownedSelectedCount})`}
                </button>
              )}
            </>
          )}
        </div>
      )}

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
            multiple
            onChange={(e) => {
              handleFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <span className="library-upload-icon">&#8682;</span>
          {uploading ? 'Uploading...' : 'Drop .qgif files here or click to upload'}
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
      ) : displayItems.length === 0 ? (
        <div className="library-empty">
          {searchQuery.trim()
            ? 'No files match your search.'
            : 'No .qgif files yet. Be the first to upload one!'}
        </div>
      ) : (
        <div className="library-grid">
          {displayItems.map((item) => (
            <div
              className={`library-card${selectMode && selectedIds.has(item.id) ? ' selected' : ''}`}
              key={item.id}
              onClick={selectMode ? () => toggleSelect(item.id) : undefined}
            >
              {selectMode && (
                <div className="library-card-checkbox">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(item.id)}
                    onChange={() => toggleSelect(item.id)}
                    onClick={(e) => e.stopPropagation()}
                  />
                </div>
              )}
              <div className="library-card-preview">
                <LazyLibraryPreview apiUrl={apiUrl} id={item.id} />
              </div>
              <div className="library-card-info">
                <div className="library-card-name">{item.filename}</div>
                <div className="library-card-meta">
                  {item.frameCount} frames &middot; {formatSize(item.size)}
                </div>
                <div className="library-card-meta">
                  by {item.uploader} &middot; {formatDate(item.uploadedAt)}
                </div>
                {!selectMode && (
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
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
