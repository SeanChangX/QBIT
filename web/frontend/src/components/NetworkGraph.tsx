import { useEffect, useRef, useState, useCallback } from 'react';
import { Network } from 'vis-network/standalone';
import { DataSet } from 'vis-data/standalone';
import type { Device, OnlineUser } from '../types';

const HUB_ID = '__hub__';
const USER_NODE_PREFIX = 'user:';

function userNodeId(userId: string): string {
  return USER_NODE_PREFIX + userId;
}

interface Props {
  devices: Device[];
  onlineUsers: OnlineUser[];
  currentUserId: string | null;
  friendIds?: string[];
  /** All friend pairs (global); edges drawn for pairs where both users are online */
  friendPairs?: Array<{ a: string; b: string }>;
  /** When a device or user receives a poke, show glow on that node (seq = combo count) */
  pokeHighlight?: { deviceId?: string; publicUserId?: string; seq: number } | null;
  onPokeHighlightEnd?: () => void;
  onSelectDevice: (device: Device) => void;
  onSelectUser: (user: OnlineUser) => void;
}

// All edges use gradient (inherit node colors); shorter length for friends/own so they cluster
const EDGE_FRIEND_LENGTH = 100;
const EDGE_OTHER_LENGTH = 180;

const GLOW_COLOR_DEVICE = '#d32f2f';
const GLOW_COLOR_USER = '#1976d2';
const GLOW_RAMP_MS = 120;   // quick brighten
const GLOW_FADE_MS = 1000;  // then fade back over 1s
const GLOW_MAX_COMBO = 5;

export default function NetworkGraph({
  devices,
  onlineUsers,
  currentUserId,
  friendIds = [],
  friendPairs = [],
  pokeHighlight = null,
  onPokeHighlightEnd,
  onSelectDevice,
  onSelectUser,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const networkRef = useRef<Network | null>(null);
  const nodesRef = useRef(new DataSet<Record<string, unknown>>());
  const edgesRef = useRef(new DataSet<Record<string, unknown>>());
  const [labelsVisible, setLabelsVisible] = useState(true);
  const labelsVisibleRef = useRef(true);

  const devicesRef = useRef(devices);
  const onlineUsersRef = useRef(onlineUsers);
  const currentUserIdRef = useRef(currentUserId);
  const friendIdsRef = useRef(friendIds);
  const onSelectDeviceRef = useRef(onSelectDevice);
  const onSelectUserRef = useRef(onSelectUser);
  useEffect(() => {
    devicesRef.current = devices;
  }, [devices]);
  useEffect(() => {
    onlineUsersRef.current = onlineUsers;
  }, [onlineUsers]);
  useEffect(() => {
    currentUserIdRef.current = currentUserId;
  }, [currentUserId]);
  useEffect(() => {
    friendIdsRef.current = friendIds;
  }, [friendIds]);
  const friendPairsRef = useRef(friendPairs);
  useEffect(() => {
    friendPairsRef.current = friendPairs;
  }, [friendPairs]);
  useEffect(() => {
    onSelectDeviceRef.current = onSelectDevice;
  }, [onSelectDevice]);
  useEffect(() => {
    onSelectUserRef.current = onSelectUser;
  }, [onSelectUser]);

  // Initialise vis-network once
  useEffect(() => {
    if (!containerRef.current) return;

    // Central hub node (guard against StrictMode double-mount in dev)
    if (!nodesRef.current.get(HUB_ID)) {
      nodesRef.current.add({
        id: HUB_ID,
        label: '',
        shape: 'hexagon',
        size: 45,
        color: {
          border: '#d32f2f',
          background: '#1a1a1a',
          highlight: { border: '#ff4d4d', background: '#222' },
          hover: { border: '#ff4d4d', background: '#222' },
        },
        font: { color: '#fff', size: 16, bold: { color: '#fff' } },
        fixed: true,
        x: 0,
        y: 0,
      });
    }

    networkRef.current = new Network(
      containerRef.current,
      { nodes: nodesRef.current, edges: edgesRef.current },
      {
        nodes: {
          shape: 'dot',
          size: 22,
          font: { color: '#ffffff', size: 13, face: 'Inter, sans-serif', multi: 'html' },
          borderWidth: 2,
          shadow: { enabled: true, size: 6, color: 'rgba(0,0,0,0.3)' },
          color: {
            border: '#d32f2f',
            background: '#242424',
            highlight: { border: '#ff4d4d', background: '#333333' },
            hover: { border: '#ff4d4d', background: '#2c2c2c' },
          },
        },
        edges: {
          width: 1,
          color: { color: '#444', highlight: '#d32f2f', hover: '#666' },
          smooth: { enabled: true, type: 'continuous', roundness: 0.5 },
        },
        physics: {
          barnesHut: {
            gravitationalConstant: -3000,
            centralGravity: 0.3,
            springLength: 130,
            springConstant: 0.04,
          },
          stabilization: { iterations: 100 },
        },
        interaction: {
          hover: true,
          tooltipDelay: 200,
          selectable: true,
          dragNodes: true,
        },
      }
    );

    // Click handler -- open poke dialog for device nodes or user poke for user nodes (self not clickable)
    networkRef.current.on('click', (params: { nodes: string[] }) => {
      if (params.nodes.length === 0 || params.nodes[0] === HUB_ID) return;
      const id = params.nodes[0];
      if (id.startsWith(USER_NODE_PREFIX)) {
        const publicUserId = id.slice(USER_NODE_PREFIX.length);
        if (publicUserId === currentUserIdRef.current) return;
        const onlineUser = onlineUsersRef.current.find((u) => u.publicUserId === publicUserId);
        if (onlineUser) onSelectUserRef.current(onlineUser);
      } else {
        const device = devicesRef.current.find((d) => d.id === id);
        if (device) onSelectDeviceRef.current(device);
      }
    });

    return () => {
      networkRef.current?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync devices and online users to vis-network datasets
  useEffect(() => {
    const nodes = nodesRef.current;
    const edges = edgesRef.current;
    const now = Date.now();

    const currentIds = (nodes.getIds() as string[]).filter((id) => id !== HUB_ID);
    const deviceIds = new Set(devices.map((d) => d.id));
    const userIds = new Set(onlineUsers.map((u) => userNodeId(u.publicUserId)));

    // Remove nodes that went offline
    currentIds.forEach((id) => {
      const isDevice = !id.startsWith(USER_NODE_PREFIX);
      const stillPresent = isDevice ? deviceIds.has(id) : userIds.has(id);
      if (!stillPresent) {
        nodes.remove(id);
        const toRemove = edges.get({
          filter: (e: Record<string, unknown>) => e.to === id,
        });
        edges.remove(toRemove.map((e: Record<string, unknown>) => e.id as string));
      }
    });

    const uptimes = devices.map((d) => now - new Date(d.connectedAt).getTime());
    const maxUptime = Math.max(...uptimes, 1);
    const userEdgeLength = 200;

    // Add or update device nodes
    devices.forEach((d) => {
      let label = d.name;
      if (d.claimedBy && d.claimedBy.userName) {
        label += `\n${d.claimedBy.userName}`;
      }
      const nodeConfig: Record<string, unknown> = { id: d.id, label };
      if (d.claimedBy && d.claimedBy.userAvatar) {
        nodeConfig.shape = 'circularImage';
        nodeConfig.image = d.claimedBy.userAvatar;
        nodeConfig.size = 24;
        nodeConfig.borderWidth = 2;
        nodeConfig.color = {
          border: '#d32f2f',
          highlight: { border: '#ff4d4d' },
          hover: { border: '#ff4d4d' },
        };
      } else {
        nodeConfig.shape = 'dot';
        nodeConfig.image = undefined;
        nodeConfig.size = 22;
      }
      const uptime = now - new Date(d.connectedAt).getTime();
      const ratio = uptime / maxUptime;
      const edgeLength = 300 - ratio * 180;
      if (nodes.get(d.id)) {
        nodes.update(nodeConfig);
        edges.update({ id: `edge-${d.id}`, length: edgeLength });
      } else {
        nodes.add(nodeConfig);
        edges.add({ id: `edge-${d.id}`, from: HUB_ID, to: d.id, length: edgeLength });
      }
    });

    // Add or update user nodes (distinct color: blue)
    const userColor = {
      border: '#1976d2',
      background: '#1565c0',
      highlight: { border: '#42a5f5', background: '#1976d2' },
      hover: { border: '#42a5f5', background: '#0d47a1' },
    };
    onlineUsers.forEach((u) => {
      const id = userNodeId(u.publicUserId);
      const nodeConfig: Record<string, unknown> = {
        id,
        label: u.displayName,
        color: userColor,
      };
      if (u.avatar) {
        nodeConfig.shape = 'circularImage';
        nodeConfig.image = u.avatar;
        nodeConfig.size = 24;
        nodeConfig.borderWidth = 2;
        nodeConfig.color = {
          border: '#1976d2',
          highlight: { border: '#42a5f5' },
          hover: { border: '#42a5f5' },
        };
      } else {
        nodeConfig.shape = 'dot';
        nodeConfig.size = 22;
      }
      if (nodes.get(id)) {
        nodes.update(nodeConfig);
        edges.update({ id: `edge-${id}`, length: userEdgeLength });
      } else {
        nodes.add(nodeConfig);
        edges.add({ id: `edge-${id}`, from: HUB_ID, to: id, length: userEdgeLength });
      }
    });

    // User-to-user friend edges (global: all friend pairs where both users are online)
    const friendEdgeIds = new Set<string>();
    friendPairs.forEach(({ a, b }) => {
      const fromId = userNodeId(a);
      const toId = userNodeId(b);
      if (!userIds.has(fromId) || !userIds.has(toId)) return;
      const [pa, pb] = a < b ? [a, b] : [b, a];
      const eid = `edge-friend-${pa}-${pb}`;
      friendEdgeIds.add(eid);
      if (edges.get(eid)) {
        edges.update({ id: eid, color: { inherit: 'both' as const }, length: EDGE_FRIEND_LENGTH });
      } else {
        edges.add({
          id: eid,
          from: fromId,
          to: toId,
          color: { inherit: 'both' as const },
          length: EDGE_FRIEND_LENGTH,
        });
      }
    });

    // Device-to-user edges: claimed device -> owner, and my device -> my friends (all gradient inherit)
    const d2uEdgeIds = new Set<string>();
    devices.forEach((d) => {
      if (!d.claimedBy?.publicUserId) return;
      const ownerNodeId = userNodeId(d.claimedBy.publicUserId);
      if (!userIds.has(ownerNodeId)) return;
      const edgeId = `edge-d2u-${d.id}-${d.claimedBy.publicUserId}`;
      d2uEdgeIds.add(edgeId);
      const isMyClaim = d.claimedBy.publicUserId === currentUserId;
      const len = isMyClaim ? EDGE_FRIEND_LENGTH : EDGE_OTHER_LENGTH;
      if (edges.get(edgeId)) {
        if (isMyClaim) {
          edges.update({
            id: edgeId,
            from: ownerNodeId,
            to: d.id,
            color: { inherit: 'both' as const },
            length: len,
          });
        } else {
          edges.update({ id: edgeId, from: d.id, to: ownerNodeId, color: { inherit: 'both' as const }, length: len });
        }
      } else {
        if (isMyClaim) {
          edges.add({
            id: edgeId,
            from: ownerNodeId,
            to: d.id,
            color: { inherit: 'both' as const },
            length: len,
          });
        } else {
          edges.add({ id: edgeId, from: d.id, to: ownerNodeId, color: { inherit: 'both' as const }, length: len });
        }
      }
      if (isMyClaim && friendIds.length > 0) {
        friendIds.forEach((friendId) => {
          const friendNodeId = userNodeId(friendId);
          if (!userIds.has(friendNodeId)) return;
          const friendEdgeId = `edge-d2u-${d.id}-friend-${friendId}`;
          d2uEdgeIds.add(friendEdgeId);
          if (edges.get(friendEdgeId)) {
            edges.update({ id: friendEdgeId, color: { inherit: 'both' as const }, length: EDGE_FRIEND_LENGTH });
          } else {
            edges.add({
              id: friendEdgeId,
              from: d.id,
              to: friendNodeId,
              color: { inherit: 'both' as const },
              length: EDGE_FRIEND_LENGTH,
            });
          }
        });
      }
    });
    // Remove stale d2u and friend edges
    const allEdgeIds = edges.getIds() as string[];
    allEdgeIds.forEach((eid) => {
      if ((eid.startsWith('edge-d2u-') && !d2uEdgeIds.has(eid)) ||
          (eid.startsWith('edge-friend-') && !friendEdgeIds.has(eid))) {
        edges.remove(eid);
      }
    });
    // Re-apply poke glow if active (sync above overwrites node options)
    if (glowStateRef.current) {
      const { nodeId, shadow } = glowStateRef.current;
      if (nodes.get(nodeId)) nodes.update({ id: nodeId, shadow });
    }
  }, [devices, onlineUsers, currentUserId, friendIds, friendPairs]);

  // Poke highlight: pulse on poke only – brighten then fade back over 1s; combo stacks brightness (max 5)
  const glowStateRef = useRef<{ nodeId: string; shadow: { enabled: boolean; color: string; size: number; x: number; y: number } } | null>(null);
  const glowCleanupRef = useRef<{
    nodeId: string;
    combo: number;
    fadeEndTime: number;
    startTime: number;
    timeout: ReturnType<typeof setTimeout>;
    frame: number;
    r: number;
    g: number;
    b: number;
  } | null>(null);
  useEffect(() => {
    if (!pokeHighlight || (!pokeHighlight.deviceId && !pokeHighlight.publicUserId)) {
      if (glowCleanupRef.current) {
        const { nodeId, timeout, frame } = glowCleanupRef.current;
        clearTimeout(timeout);
        cancelAnimationFrame(frame);
        nodesRef.current.update({ id: nodeId, shadow: { enabled: false, size: 0, x: 0, y: 0 } });
        glowCleanupRef.current = null;
        glowStateRef.current = null;
      }
      onPokeHighlightEnd?.();
      return;
    }
    const nodeId = pokeHighlight.deviceId != null
      ? pokeHighlight.deviceId
      : userNodeId(pokeHighlight.publicUserId!);
    const nodes = nodesRef.current;
    const existing = nodes.get(nodeId) as { size?: number } | undefined;
    if (!existing) {
      onPokeHighlightEnd?.();
      return;
    }
    const combo = Math.min(pokeHighlight.seq, GLOW_MAX_COMBO);
    const isUser = pokeHighlight.publicUserId != null;
    const glowColor = isUser ? GLOW_COLOR_USER : GLOW_COLOR_DEVICE;
    const [r, g, b] = [parseInt(glowColor.slice(1, 3), 16), parseInt(glowColor.slice(3, 5), 16), parseInt(glowColor.slice(5, 7), 16)];

    const now = Date.now();
    if (glowCleanupRef.current && glowCleanupRef.current.nodeId === nodeId) {
      glowCleanupRef.current.combo = combo;
      glowCleanupRef.current.fadeEndTime = now + GLOW_FADE_MS;
      return;
    }
    if (glowCleanupRef.current && glowCleanupRef.current.nodeId !== nodeId) {
      const prev = glowCleanupRef.current;
      clearTimeout(prev.timeout);
      cancelAnimationFrame(prev.frame);
      nodes.update({ id: prev.nodeId, shadow: { enabled: false, size: 0, x: 0, y: 0 } });
      glowCleanupRef.current = null;
    }

    const startTime = now;
    const fadeEndTime = now + GLOW_RAMP_MS + GLOW_FADE_MS;
    const rafIdRef = { current: 0 };

    const pulse = () => {
      const cur = glowCleanupRef.current;
      if (!cur || cur.nodeId !== nodeId) return;
      const t = Date.now();
      if (t >= cur.fadeEndTime) {
        nodes.update({ id: nodeId, shadow: { enabled: false, size: 0, x: 0, y: 0 } });
        glowCleanupRef.current = null;
        glowStateRef.current = null;
        onPokeHighlightEnd?.();
        return;
      }
      const elapsed = t - cur.startTime;
      const peakSize = 18 + cur.combo * 5;
      const peakAlpha = 0.5 + cur.combo * 0.1;
      let size: number;
      let alpha: number;
      if (elapsed < GLOW_RAMP_MS) {
        const k = elapsed / GLOW_RAMP_MS;
        size = peakSize * k;
        alpha = peakAlpha * k;
      } else {
        const fadeRemain = cur.fadeEndTime - t;
        const k = Math.max(0, fadeRemain / GLOW_FADE_MS);
        size = peakSize * k;
        alpha = peakAlpha * k;
      }
      const shadowColor = `rgba(${cur.r},${cur.g},${cur.b},${alpha})`;
      const shadow = { enabled: true, color: shadowColor, size, x: 0, y: 0 };
      nodes.update({ id: nodeId, shadow });
      glowStateRef.current = { nodeId, shadow };
      rafIdRef.current = requestAnimationFrame(pulse);
    };
    rafIdRef.current = requestAnimationFrame(pulse);
    const timeout = setTimeout(() => {
      cancelAnimationFrame(rafIdRef.current);
      if (glowCleanupRef.current?.nodeId === nodeId) {
        nodes.update({ id: nodeId, shadow: { enabled: false, size: 0, x: 0, y: 0 } });
        glowCleanupRef.current = null;
        glowStateRef.current = null;
      }
      onPokeHighlightEnd?.();
    }, GLOW_RAMP_MS + GLOW_FADE_MS + 50);
    glowCleanupRef.current = {
      nodeId,
      combo,
      fadeEndTime,
      startTime,
      timeout,
      frame: rafIdRef.current,
      r,
      g,
      b,
    };

    return () => {
      clearTimeout(timeout);
      cancelAnimationFrame(rafIdRef.current);
      if (glowCleanupRef.current?.nodeId === nodeId) glowCleanupRef.current = null;
    };
  }, [pokeHighlight, onPokeHighlightEnd]);

  // Center / fit the view
  const handleFit = useCallback(() => {
    networkRef.current?.fit({ animation: { duration: 400, easingFunction: 'easeInOutQuad' } });
  }, []);

  // Toggle label visibility
  const handleToggleLabels = useCallback(() => {
    const next = !labelsVisibleRef.current;
    labelsVisibleRef.current = next;
    setLabelsVisible(next);
    const nodes = nodesRef.current;
    const allIds = (nodes.getIds() as string[]).filter((id) => id !== HUB_ID);
    allIds.forEach((id) => {
      nodes.update({ id, font: { color: next ? '#ffffff' : 'transparent' } });
    });
  }, []);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div
        ref={containerRef}
        className="network-graph-container"
        style={{ width: '100%', height: '100%', background: '#0e0e0e' }}
      />
      <div className="network-fab-group">
        <button
          className="network-fab"
          onClick={handleFit}
          title="Center view"
          aria-label="Center view"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M3 12h3m12 0h3M12 3v3m0 12v3" />
          </svg>
        </button>
        <button
          className={`network-fab${labelsVisible ? '' : ' network-fab-off'}`}
          onClick={handleToggleLabels}
          title={labelsVisible ? 'Hide labels' : 'Show labels'}
          aria-label={labelsVisible ? 'Hide labels' : 'Show labels'}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 7V4h16v3" />
            <path d="M9 20h6" />
            <path d="M12 4v16" />
          </svg>
        </button>
      </div>
    </div>
  );
}
