#!/usr/bin/env python3
"""
Convert a .qgif binary file to a C PROGMEM header file.
Output format matches sys_scx.h (AnimatedGIF struct).

Usage: python3 qgif2header.py <input.qgif> <output.h> <varname>
Example: python3 qgif2header.py sys_idle.qgif sys_idle.h sys_idle
"""

import sys
import struct

def main():
    if len(sys.argv) != 4:
        print(f"Usage: {sys.argv[0]} <input.qgif> <output.h> <varname>")
        sys.exit(1)

    infile, outfile, varname = sys.argv[1], sys.argv[2], sys.argv[3]
    guard = varname.upper() + "_H"
    prefix = varname

    with open(infile, "rb") as f:
        data = f.read()

    # Parse header
    frame_count = data[0]
    width = struct.unpack_from("<H", data, 1)[0]
    height = struct.unpack_from("<H", data, 3)[0]

    print(f"Frames: {frame_count}, Size: {width}x{height}")

    # Parse delays
    delays = []
    offset = 5
    for i in range(frame_count):
        d = struct.unpack_from("<H", data, offset)[0]
        delays.append(d)
        offset += 2

    # Parse frames
    frame_size = (width // 8) * height  # should be 1024 for 128x64
    frames = []
    for i in range(frame_count):
        frame = data[offset : offset + frame_size]
        if len(frame) != frame_size:
            print(f"Error: frame {i} truncated ({len(frame)} < {frame_size})")
            sys.exit(1)
        frames.append(frame)
        offset += frame_size

    # Generate header
    with open(outfile, "w") as out:
        out.write(f"#ifndef {guard}\n")
        out.write(f"#define {guard}\n\n")
        out.write("#include <stdint.h>\n")
        out.write("#include <pgmspace.h>\n\n")

        out.write("// Definition of data structure for GIF\n")
        out.write("#ifndef ANIMATED_GIF_DEFINED\n")
        out.write("#define ANIMATED_GIF_DEFINED\n")
        out.write("typedef struct {\n")
        out.write("    const uint8_t frame_count;\n")
        out.write("    const uint16_t width;\n")
        out.write("    const uint16_t height;\n")
        out.write("    const uint16_t* delays;\n")
        out.write("    const uint8_t (* frames)[1024];\n")
        out.write("} AnimatedGIF;\n")
        out.write("#endif // ANIMATED_GIF_DEFINED\n\n")

        FC = f"{prefix.upper()}_FRAME_COUNT"
        W = f"{prefix.upper()}_WIDTH"
        H = f"{prefix.upper()}_HEIGHT"

        out.write(f"#define {FC} {frame_count}\n")
        out.write(f"#define {W} {width}\n")
        out.write(f"#define {H} {height}\n\n")

        # Delays array
        delay_str = ", ".join(str(d) for d in delays)
        out.write(f"const uint16_t {prefix}_delays[{FC}] = {{{delay_str}}};\n\n")

        # Frames array
        out.write(f"PROGMEM const uint8_t {prefix}_frames[{FC}][1024] = {{\n")
        for fi, frame in enumerate(frames):
            out.write("  {\n")
            for row_start in range(0, len(frame), 16):
                chunk = frame[row_start : row_start + 16]
                hex_vals = ", ".join(f"0x{b:02x}" for b in chunk)
                comma = "," if row_start + 16 < len(frame) else ""
                out.write(f"    {hex_vals}{comma}\n")
            comma = "," if fi < frame_count - 1 else ""
            out.write(f"  }}{comma}\n")
        out.write("};\n\n")

        # AnimatedGIF struct instance
        out.write(f"const AnimatedGIF {prefix}_gif = {{\n")
        out.write(f"    {FC},\n")
        out.write(f"    {W},\n")
        out.write(f"    {H},\n")
        out.write(f"    {prefix}_delays,\n")
        out.write(f"    {prefix}_frames\n")
        out.write("};\n\n")

        out.write(f"#endif // {guard}\n")

    print(f"Generated {outfile} ({frame_count} frames, {width}x{height})")

if __name__ == "__main__":
    main()
