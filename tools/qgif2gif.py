#!/usr/bin/env python3
"""
qgif2gif.py -- Convert QBIT .qgif binary format back to GIF animations.

Binary format (.qgif):
  [0]       uint8   frame_count
  [1..2]    uint16  width   (little-endian)
  [3..4]    uint16  height  (little-endian)
  [5..]     uint16  delays[frame_count]  (LE, milliseconds)
  [..]      uint8   frames[frame_count][width/8 * height]  (monochrome bitmap)

Usage:
  python qgif2gif.py input.qgif
  python qgif2gif.py input.qgif -o output.gif
  python qgif2gif.py *.qgif
  python qgif2gif.py /path/to/qgifs/
  python qgif2gif.py input.qgif --invert --scale 4
"""

import argparse
import struct
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    print("Error: Pillow is required.  Install with:  pip install Pillow")
    sys.exit(1)


def bitmap_to_image(bitmap, width, height, invert=False):
    """Convert a monochrome bitmap (horizontal scan, MSB first) back to
    a grayscale PIL Image.
    Default polarity matches gif2qbit: bit ON -> dark pixel (0),
    bit OFF -> white pixel (255)."""
    img = Image.new("L", (width, height), 255)
    pixels = img.load()
    bytes_per_row = width // 8

    for y in range(height):
        for x in range(width):
            byte_idx = y * bytes_per_row + (x // 8)
            bit_idx = 7 - (x % 8)
            bit_on = (bitmap[byte_idx] >> bit_idx) & 1

            if invert:
                bit_on = not bit_on

            # bit ON -> dark pixel (0), bit OFF -> white pixel (255)
            pixels[x, y] = 0 if bit_on else 255

    return img


def convert_qgif(input_path, output_path=None, invert=False, scale=1):
    """Convert a .qgif file back to an animated GIF. Returns True on success."""
    input_path = Path(input_path)
    if output_path is None:
        output_path = input_path.with_suffix(".gif")
    else:
        output_path = Path(output_path)

    try:
        data = input_path.read_bytes()
    except Exception as exc:
        print(f"Error reading {input_path}: {exc}")
        return False

    if len(data) < 5:
        print(f"Error: {input_path} is too small to be a valid .qgif file")
        return False

    # --- Parse header ---
    frame_count = struct.unpack_from("<B", data, 0)[0]
    width = struct.unpack_from("<H", data, 1)[0]
    height = struct.unpack_from("<H", data, 3)[0]

    if frame_count == 0:
        print(f"Error: {input_path} has 0 frames")
        return False

    frame_size = (width // 8) * height
    header_size = 5
    delays_size = frame_count * 2
    expected_size = header_size + delays_size + frame_count * frame_size

    if len(data) < expected_size:
        print(f"Error: {input_path} is truncated "
              f"(expected {expected_size} bytes, got {len(data)})")
        return False

    # --- Parse delays ---
    delays = []
    offset = header_size
    for i in range(frame_count):
        delay = struct.unpack_from("<H", data, offset)[0]
        delays.append(delay)
        offset += 2

    # --- Parse frames ---
    frames = []
    for i in range(frame_count):
        bitmap = data[offset:offset + frame_size]
        img = bitmap_to_image(bitmap, width, height, invert)

        # Optionally scale up for better visibility
        if scale > 1:
            img = img.resize(
                (width * scale, height * scale),
                Image.NEAREST  # nearest-neighbor preserves sharp pixels
            )

        # Convert to palette mode for GIF
        frames.append(img.convert("P"))
        offset += frame_size

    # --- Write animated GIF ---
    if len(frames) == 1:
        frames[0].save(output_path, format="GIF")
    else:
        # GIF delay is in milliseconds, Pillow expects ms too
        frames[0].save(
            output_path,
            format="GIF",
            save_all=True,
            append_images=frames[1:],
            duration=delays,
            loop=0,
        )

    total_kb = len(data) / 1024
    out_w = width * scale
    out_h = height * scale
    print(f"  {input_path.name}  ->  {output_path.name}  "
          f"({frame_count} frames, {out_w}x{out_h}, source {total_kb:.1f} KB)")
    return True


def main():
    parser = argparse.ArgumentParser(
        description="Convert QBIT .qgif binary files back to GIF animations.")
    parser.add_argument("input", nargs="+",
                        help=".qgif file(s) or directory containing .qgif files")
    parser.add_argument("-o", "--output",
                        help="Output path (single-file mode only)")
    parser.add_argument("--invert", action="store_true",
                        help="Invert colours (swap black and white)")
    parser.add_argument("--scale", type=int, default=1,
                        help="Scale factor for output (default: 1, "
                             "e.g. 4 for 512x256)")
    args = parser.parse_args()

    # Collect input files
    files = []
    for p in args.input:
        path = Path(p)
        if path.is_dir():
            files.extend(sorted(path.glob("*.qgif")))
        elif path.is_file():
            files.append(path)
        else:
            print(f"Warning: {p} not found, skipping")

    if not files:
        print("No .qgif files found.")
        sys.exit(1)

    if args.output and len(files) > 1:
        print("Error: -o/--output can only be used with a single input file")
        sys.exit(1)

    print(f"Converting {len(files)} file(s)...\n")
    ok = sum(
        convert_qgif(f, args.output, args.invert, args.scale)
        for f in files
    )
    print(f"\nDone: {ok}/{len(files)} converted successfully.")


if __name__ == "__main__":
    main()
