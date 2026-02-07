#!/usr/bin/env python3
"""
gif2qbit.py -- Convert GIF animations to QBIT .qgif binary format.

Binary format (.qgif):
  [0]       uint8   frame_count
  [1..2]    uint16  width   (little-endian)
  [3..4]    uint16  height  (little-endian)
  [5..]     uint16  delays[frame_count]  (LE, milliseconds)
  [..]      uint8   frames[frame_count][1024]  (128x64 monochrome bitmap)

Usage:
  python gif2qbit.py input.gif
  python gif2qbit.py input.gif -o output.qgif
  python gif2qbit.py *.gif
  python gif2qbit.py /path/to/gifs/
  python gif2qbit.py input.gif --threshold 100 --invert --scale stretch
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

DISPLAY_WIDTH  = 128
DISPLAY_HEIGHT = 64
FRAME_SIZE     = (DISPLAY_WIDTH // 8) * DISPLAY_HEIGHT  # 1024 bytes


def frame_to_bitmap(gray_img, threshold=128, invert=False):
    """Convert a DISPLAY_WIDTH x DISPLAY_HEIGHT grayscale image to a
    monochrome bitmap (horizontal scan, MSB first).
    Default polarity: dark pixel -> bit ON (matches gif2cpp inverted mode
    and the firmware's ~bitwise-NOT in gifRenderFrame)."""
    pixels = gray_img.load()
    bitmap = bytearray(FRAME_SIZE)

    for y in range(DISPLAY_HEIGHT):
        for x in range(DISPLAY_WIDTH):
            bit_on = pixels[x, y] < threshold   # dark pixel -> bit ON
            if invert:
                bit_on = not bit_on
            if bit_on:
                byte_idx = y * (DISPLAY_WIDTH // 8) + (x // 8)
                bit_idx  = 7 - (x % 8)
                bitmap[byte_idx] |= (1 << bit_idx)

    return bytes(bitmap)


def resize_frame(img, scale="fit"):
    """Resize a PIL Image to DISPLAY_WIDTH x DISPLAY_HEIGHT using the
    chosen scale mode.  Returns a grayscale ('L') image."""
    if img.mode != "L":
        # Composite RGBA onto black background, then convert to grayscale
        if img.mode == "RGBA":
            bg = Image.new("RGBA", img.size, (0, 0, 0, 255))
            img = Image.alpha_composite(bg, img)
        img = img.convert("L")

    w, h = img.size

    if scale == "stretch":
        return img.resize((DISPLAY_WIDTH, DISPLAY_HEIGHT), Image.LANCZOS)

    if scale == "fit_width":
        ratio  = DISPLAY_WIDTH / w
        new_h  = max(1, int(h * ratio))
        resized = img.resize((DISPLAY_WIDTH, new_h), Image.LANCZOS)
    elif scale == "fit_height":
        ratio  = DISPLAY_HEIGHT / h
        new_w  = max(1, int(w * ratio))
        resized = img.resize((new_w, DISPLAY_HEIGHT), Image.LANCZOS)
    else:  # "fit" -- fit within bounds, maintain aspect ratio
        ratio  = min(DISPLAY_WIDTH / w, DISPLAY_HEIGHT / h)
        new_w  = max(1, int(w * ratio))
        new_h  = max(1, int(h * ratio))
        resized = img.resize((new_w, new_h), Image.LANCZOS)

    # Centre on a black canvas
    canvas = Image.new("L", (DISPLAY_WIDTH, DISPLAY_HEIGHT), 0)
    x_off  = (DISPLAY_WIDTH  - resized.width)  // 2
    y_off  = (DISPLAY_HEIGHT - resized.height) // 2
    canvas.paste(resized, (x_off, y_off))
    return canvas


def convert_gif(input_path, output_path=None, threshold=128,
                invert=False, scale="fit"):
    """Convert a GIF file to .qgif binary.  Returns True on success."""
    input_path = Path(input_path)
    if output_path is None:
        output_path = input_path.with_suffix(".qgif")
    else:
        output_path = Path(output_path)

    try:
        img = Image.open(input_path)
    except Exception as exc:
        print(f"Error opening {input_path}: {exc}")
        return False

    frames = []
    delays = []

    try:
        while True:
            delay = img.info.get("duration", 100)
            if delay <= 0:
                delay = 100
            delays.append(delay)

            gray    = resize_frame(img.convert("RGBA"), scale)
            bitmap  = frame_to_bitmap(gray, threshold, invert)
            frames.append(bitmap)

            img.seek(img.tell() + 1)
    except EOFError:
        pass

    frame_count = len(frames)
    if frame_count == 0:
        print(f"Error: no frames found in {input_path}")
        return False
    if frame_count > 255:
        print(f"Warning: {input_path} has {frame_count} frames, "
              f"truncating to 255")
        frames = frames[:255]
        delays = delays[:255]
        frame_count = 255

    # --- Write .qgif binary ---
    with open(output_path, "wb") as f:
        f.write(struct.pack("<B", frame_count))
        f.write(struct.pack("<H", DISPLAY_WIDTH))
        f.write(struct.pack("<H", DISPLAY_HEIGHT))
        for d in delays:
            f.write(struct.pack("<H", d))
        for bitmap in frames:
            f.write(bitmap)

    total_kb = (5 + frame_count * 2 + frame_count * FRAME_SIZE) / 1024
    print(f"  {input_path.name}  ->  {output_path.name}  "
          f"({frame_count} frames, {total_kb:.1f} KB)")
    return True


def main():
    parser = argparse.ArgumentParser(
        description="Convert GIF animations to QBIT .qgif binary format.")
    parser.add_argument("input", nargs="+",
                        help="GIF file(s) or directory containing .gif files")
    parser.add_argument("-o", "--output",
                        help="Output path (single-file mode only)")
    parser.add_argument("-t", "--threshold", type=int, default=128,
                        help="Black/white threshold 0-255 (default: 128)")
    parser.add_argument("--invert", action="store_true",
                        help="Invert colours (swap black and white)")
    parser.add_argument("--scale",
                        choices=["fit", "stretch", "fit_width", "fit_height"],
                        default="fit",
                        help="Scale mode (default: fit)")
    args = parser.parse_args()

    # Collect input files
    files = []
    for p in args.input:
        path = Path(p)
        if path.is_dir():
            files.extend(sorted(path.glob("*.gif")))
        elif path.is_file():
            files.append(path)
        else:
            print(f"Warning: {p} not found, skipping")

    if not files:
        print("No GIF files found.")
        sys.exit(1)

    if args.output and len(files) > 1:
        print("Error: -o/--output can only be used with a single input file")
        sys.exit(1)

    print(f"Converting {len(files)} file(s)...\n")
    ok = sum(
        convert_gif(f, args.output, args.threshold, args.invert, args.scale)
        for f in files
    )
    print(f"\nDone: {ok}/{len(files)} converted successfully.")


if __name__ == "__main__":
    main()
