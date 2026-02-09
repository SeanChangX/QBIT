// generate-icons.js
// Converts icon.svg to multiple PNG sizes for cross-platform favicon support.
// Runs automatically as a prebuild step during `npm run build` (Docker build).

import sharp from 'sharp';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(__dirname, '..', 'public');
const svgPath = resolve(publicDir, 'icon.svg');

if (!existsSync(svgPath)) {
  console.warn('[generate-icons] icon.svg not found, skipping icon generation');
  process.exit(0);
}

const svgBuffer = readFileSync(svgPath);

// Add a dark background to the SVG for PNG rendering (icon.svg has white on transparent)
const svgWithBg = Buffer.from(
  svgBuffer
    .toString()
    .replace('<svg ', '<svg style="background:#0e0e0e" ')
);

const sizes = [
  { name: 'favicon-16x16.png', size: 16 },
  { name: 'favicon-32x32.png', size: 32 },
  { name: 'apple-touch-icon.png', size: 180 },
  { name: 'android-chrome-192x192.png', size: 192 },
  { name: 'android-chrome-512x512.png', size: 512 },
];

async function generate() {
  for (const { name, size } of sizes) {
    const output = resolve(publicDir, name);
    if (existsSync(output)) {
      // Skip if already generated (avoids re-generating on every build)
      continue;
    }
    await sharp(svgWithBg)
      .resize(size, size)
      .png()
      .toFile(output);
    console.log(`[generate-icons] Created ${name} (${size}x${size})`);
  }
}

generate().catch((err) => {
  console.error('[generate-icons] Error:', err.message);
  // Non-fatal: build continues even if icon generation fails
  process.exit(0);
});
