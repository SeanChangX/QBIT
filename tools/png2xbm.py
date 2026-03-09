#!/usr/bin/env python3
"""
Convert a PNG image (up to 16x16, e.g. 15x16) to u8g2 XBM-style C array (1bpp, row-major, LSB first per byte).

Smaller sizes are padded to 16x16. Output: 32 bytes, PROGMEM, for drawXBM(x, y, 16, 16, bits).
Pixels: white (or above threshold) -> 1 (foreground), black -> 0. Use --invert for dark-on-light PNGs.

Usage:
  python3 png2xbm.py <input.png> [options]
  python3 png2xbm.py --help

Examples:
  python3 png2xbm.py icon_clock.png
  python3 png2xbm.py icon_clock.png --name icon_timer_bits -o icon_timer.h
  python3 png2xbm.py icon_gear.png --invert
"""

import argparse
import sys

try:
    from PIL import Image
except ImportError:
    print("Error: Pillow is required. Install with: pip install Pillow", file=sys.stderr)
    sys.exit(1)


W, H = 16, 16
BYTES_PER_ROW = 2  # 16 pixels / 8
TOTAL_BYTES = BYTES_PER_ROW * H


def png_to_bits(path: str, invert: bool, threshold: int) -> list[int]:
    """Load PNG (up to 16x16) and return 32 bytes (row-major, 8 pixels per byte, LSB first per byte for u8g2 XBM). Pads to 16x16."""
    img = Image.open(path)
    img = img.convert("L")  # grayscale
    iw, ih = img.size
    if iw > W or ih > H:
        raise SystemExit(f"Error: image must be at most {W}x{H} pixels, got {iw}x{ih}")

    out = []
    for y in range(H):
        row_byte0 = 0
        row_byte1 = 0
        for x in range(W):
            if x < iw and y < ih:
                lum = img.getpixel((x, y))
                bit = 1 if (lum >= threshold) != invert else 0
            else:
                bit = 0  # pad to 16x16
            # XBM / u8g2: LSB first (pixel 0 in bit 0 of byte)
            if x < 8:
                row_byte0 |= (bit << x)
            else:
                row_byte1 |= (bit << (x - 8))
        out.append(row_byte0)
        out.append(row_byte1)
    return out


def format_c_array(name: str, bytes_list: list[int]) -> str:
    """Format bytes as C array (8 bytes per line, 4+4 grouping)."""
    lines = []
    for i in range(0, TOTAL_BYTES, 8):
        chunk = bytes_list[i : i + 8]
        hex_str = ", ".join(f"0x{b:02X}" for b in chunk)
        lines.append(f"    {hex_str},")
    body = "\n".join(lines)
    return f"static const uint8_t {name}[] PROGMEM = {{\n{body}\n}};"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Convert PNG (up to 16x16) to u8g2 XBM C array (32 bytes, 1bpp, row-major). Pads to 16x16.",
        epilog="Pixels with luminance >= threshold become 1 (foreground). Use --invert for dark-on-light icons.",
    )
    parser.add_argument(
        "input",
        metavar="INPUT.png",
        help="Path to PNG image (max 16x16, e.g. 15x16; padded to 16x16)",
    )
    parser.add_argument(
        "-o", "--output",
        metavar="FILE",
        default=None,
        help="Output file (default: print to stdout)",
    )
    parser.add_argument(
        "-n", "--name",
        metavar="VARNAME",
        default=None,
        help="C array variable name (default: from input filename, e.g. icon_clock -> icon_clock_bits)",
    )
    parser.add_argument(
        "--invert",
        action="store_true",
        help="Treat dark pixels as 1 (for dark-on-light source images)",
    )
    parser.add_argument(
        "-t", "--threshold",
        type=int,
        default=128,
        metavar="0-255",
        help="Luminance threshold: pixel >= threshold -> 1 (default: 128)",
    )
    args = parser.parse_args()

    if args.name:
        name = args.name.rstrip("_")
        if not name.endswith("_bits"):
            name = name + "_bits"
    else:
        base = args.input.rsplit("/", 1)[-1].replace(".png", "").replace(".PNG", "")
        name = (base + "_bits").replace("-", "_")

    try:
        bits = png_to_bits(args.input, args.invert, args.threshold)
    except FileNotFoundError:
        print(f"Error: file not found: {args.input}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    out_str = format_c_array(name, bits)
    if args.output:
        with open(args.output, "w") as f:
            f.write(out_str)
            f.write("\n")
        print(f"Written {TOTAL_BYTES} bytes to {args.output} (variable: {name})")
    else:
        print(out_str)


if __name__ == "__main__":
    main()
