import { useEffect, useRef } from 'react';
import { Network } from 'vis-network/standalone';
import { DataSet } from 'vis-data/standalone';
import type { Device } from '../types';

interface Props {
  devices: Device[];
  onSelectDevice: (device: Device) => void;
}

const HUB_ID = '__hub__';

export default function NetworkGraph({ devices, onSelectDevice }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const networkRef = useRef<Network | null>(null);
  const nodesRef = useRef(new DataSet<Record<string, unknown>>());
  const edgesRef = useRef(new DataSet<Record<string, unknown>>());

  // Refs to avoid stale closures in the click handler
  const devicesRef = useRef(devices);
  const onSelectRef = useRef(onSelectDevice);
  useEffect(() => {
    devicesRef.current = devices;
  }, [devices]);
  useEffect(() => {
    onSelectRef.current = onSelectDevice;
  }, [onSelectDevice]);

  // Initialise vis-network once
  useEffect(() => {
    if (!containerRef.current) return;

    // Central hub node
    nodesRef.current.add({
      id: HUB_ID,
      label: 'QBIT\nNetwork',
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

    networkRef.current = new Network(
      containerRef.current,
      { nodes: nodesRef.current, edges: edgesRef.current },
      {
        nodes: {
          shape: 'dot',
          size: 22,
          font: { color: '#ffffff', size: 13, face: 'Inter, sans-serif' },
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
        },
      }
    );

    // Click handler -- open poke dialog for device nodes
    networkRef.current.on('click', (params: { nodes: string[] }) => {
      if (params.nodes.length > 0 && params.nodes[0] !== HUB_ID) {
        const id = params.nodes[0];
        const device = devicesRef.current.find((d) => d.id === id);
        if (device) onSelectRef.current(device);
      }
    });

    return () => {
      networkRef.current?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync device list to vis-network datasets
  useEffect(() => {
    const nodes = nodesRef.current;
    const edges = edgesRef.current;

    const currentIds = new Set(
      (nodes.getIds() as string[]).filter((id) => id !== HUB_ID)
    );
    const newIds = new Set(devices.map((d) => d.id));

    // Remove nodes that went offline
    currentIds.forEach((id) => {
      if (!newIds.has(id)) {
        nodes.remove(id);
        const toRemove = edges.get({
          filter: (e: Record<string, unknown>) => e.to === id,
        });
        edges.remove(toRemove.map((e: Record<string, unknown>) => e.id as string));
      }
    });

    // Add or update device nodes
    devices.forEach((d) => {
      if (currentIds.has(d.id)) {
        nodes.update({ id: d.id, label: d.name });
      } else {
        nodes.add({ id: d.id, label: d.name });
        edges.add({ id: `edge-${d.id}`, from: HUB_ID, to: d.id });
      }
    });
  }, [devices]);

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', background: '#0e0e0e' }}
    />
  );
}
