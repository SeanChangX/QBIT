#!/usr/bin/env python3
"""Release notes from CHANGELOG.md for the release workflow.

    python3 tools/release_notes.py check 1.9.4         # the version has a dated, non-empty section
    python3 tools/release_notes.py notes 1.9.4 > notes.md
    python3 tools/release_notes.py latest              # newest released version (for dry runs)

`notes` prints that section followed by the install steps. Links must be absolute: the notes are
shown on the release page, where a repository-relative link would not resolve.
"""
import re
import sys
from pathlib import Path

REPO = "SeanChangX/QBIT"
CHANGELOG = Path(__file__).resolve().parent.parent / "CHANGELOG.md"

INSTALL = """\
## Install

**Web flasher (recommended).** Open the [QBIT flasher](https://seanchangx.github.io/QBIT/) in desktop Chrome or Edge, connect the board over USB and follow the steps. It always installs the latest release. Devices already on the QBIT Network show an update notice once they see this version.

**Manual.** Write the four images with esptool at these offsets: `bootloader.bin` at `0x0`, `partitions.bin` at `0x8000`, `firmware.bin` at `0x10000`, `littlefs.bin` at `0x210000`.

Checksums of every file: `SHA256SUMS` (`sha256sum -c SHA256SUMS`). Each file also carries a build provenance attestation (`gh attestation verify <file> --repo {repo}`).
"""


def section(version: str) -> str:
    text = CHANGELOG.read_text(encoding="utf-8")
    head = re.search(rf"^## \[{re.escape(version)}\] - \d{{4}}-\d{{2}}-\d{{2}}\s*$", text, re.M)
    if not head:
        sys.exit(f"CHANGELOG.md has no '## [{version}] - YYYY-MM-DD' section")
    rest = text[head.end():]
    nxt = re.search(r"^## \[|^\[[^\]]+\]: ", rest, re.M)
    body = (rest[: nxt.start()] if nxt else rest).strip()
    if not body:
        sys.exit(f"CHANGELOG.md section {version} is empty")
    relative = [u for u in re.findall(r"\]\(([^)]+)\)", body) if not re.match(r"https?://", u)]
    if relative:
        sys.exit(f"CHANGELOG.md section {version} has relative links (use absolute URLs): {relative}")
    if f"[{version}]: https://github.com/{REPO}/compare/" not in text:
        sys.exit(f"CHANGELOG.md is missing the compare link for {version} at the bottom")
    return body


def main() -> None:
    if len(sys.argv) == 2 and sys.argv[1] == "latest":
        found = re.search(r"^## \[(\d+\.\d+\.\d+)\] - ", CHANGELOG.read_text(encoding="utf-8"), re.M)
        if not found:
            sys.exit("CHANGELOG.md has no released version")
        print(found.group(1))
        return
    if len(sys.argv) != 3 or sys.argv[1] not in ("check", "notes"):
        sys.exit(__doc__)
    cmd, version = sys.argv[1], sys.argv[2].removeprefix("v")
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        sys.exit(f"version must be X.Y.Z, got {version!r}")
    body = section(version)
    if cmd == "check":
        print(f"CHANGELOG.md: {version} ok")
        return
    prev = re.search(rf"^\[{re.escape(version)}\]: (\S+)", CHANGELOG.read_text(encoding="utf-8"), re.M)
    print(body)
    print()
    print(INSTALL.format(repo=REPO))
    print(f"**Full changelog:** {prev.group(1)}")


if __name__ == "__main__":
    main()
