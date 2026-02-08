import { useEffect, useRef } from 'react';

interface Props {
  src: string;
  scale?: number;
}

// .qgif binary format:
//   Header (5 bytes): frame_count(u8), width(u16 LE), height(u16 LE)
//   Delays: frame_count * u16 LE (milliseconds)
//   Frames: frame_count * (width/8 * height) bytes
//   Each frame is 1-bit row-major, MSB-first

const QGIF_WIDTH = 128;
const QGIF_HEIGHT = 64;
const FRAME_BYTES = (QGIF_WIDTH / 8) * QGIF_HEIGHT; // 1024

interface QgifData {
  frameCount: number;
  delays: number[];
  frames: Uint8Array[];
}

function parseQgif(buf: ArrayBuffer): QgifData | null {
  const view = new DataView(buf);
  if (buf.byteLength < 5) return null;

  const frameCount = view.getUint8(0);
  const width = view.getUint16(1, true);
  const height = view.getUint16(3, true);

  if (frameCount === 0 || width !== QGIF_WIDTH || height !== QGIF_HEIGHT) return null;

  const expectedSize = 5 + frameCount * 2 + frameCount * FRAME_BYTES;
  if (buf.byteLength < expectedSize) return null;

  const delays: number[] = [];
  for (let i = 0; i < frameCount; i++) {
    delays.push(view.getUint16(5 + i * 2, true));
  }

  const framesOffset = 5 + frameCount * 2;
  const frames: Uint8Array[] = [];
  for (let i = 0; i < frameCount; i++) {
    frames.push(new Uint8Array(buf, framesOffset + i * FRAME_BYTES, FRAME_BYTES));
  }

  return { frameCount, delays, frames };
}

function renderFrame(
  ctx: CanvasRenderingContext2D,
  frame: Uint8Array,
  scale: number
) {
  const imgData = ctx.createImageData(QGIF_WIDTH * scale, QGIF_HEIGHT * scale);
  const data = imgData.data;

  for (let y = 0; y < QGIF_HEIGHT; y++) {
    for (let x = 0; x < QGIF_WIDTH; x++) {
      const byteIdx = y * (QGIF_WIDTH / 8) + Math.floor(x / 8);
      const bitIdx = 7 - (x % 8);
      const on = (frame[byteIdx] >> bitIdx) & 1;

      // OLED look: black background, white pixels when bit is OFF
      // (qgif stores dark=1, light=0; invert for screen display)
      const lit = on ? 0 : 1;
      const r = lit ? 255 : 0;
      const g = lit ? 255 : 0;
      const b = lit ? 255 : 0;

      // Scale up pixels
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const px = (x * scale + sx);
          const py = (y * scale + sy);
          const idx = (py * QGIF_WIDTH * scale + px) * 4;
          data[idx] = r;
          data[idx + 1] = g;
          data[idx + 2] = b;
          data[idx + 3] = 255;
        }
      }
    }
  }

  ctx.putImageData(imgData, 0, 0);
}

export default function QgifPreview({ src, scale = 2 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;
    let timeoutId: number | undefined;

    async function load() {
      try {
        const resp = await fetch(src);
        if (!resp.ok || cancelled) return;
        const buf = await resp.arrayBuffer();
        if (cancelled) return;

        const qgif = parseQgif(buf);
        if (!qgif || cancelled) return;

        const canvas = canvasRef.current;
        if (!canvas) return;

        canvas.width = QGIF_WIDTH * scale;
        canvas.height = QGIF_HEIGHT * scale;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        let frame = 0;

        function tick() {
          if (cancelled || !ctx || !qgif) return;
          renderFrame(ctx, qgif.frames[frame], scale);
          const delay = Math.max(qgif.delays[frame] || 100, 16);
          frame = (frame + 1) % qgif.frameCount;
          timeoutId = window.setTimeout(tick, delay);
        }

        tick();
      } catch {
        // Failed to load, leave canvas blank
      }
    }

    load();

    return () => {
      cancelled = true;
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    };
  }, [src, scale]);

  return (
    <canvas
      ref={canvasRef}
      width={QGIF_WIDTH * scale}
      height={QGIF_HEIGHT * scale}
      style={{ imageRendering: 'pixelated' }}
    />
  );
}
