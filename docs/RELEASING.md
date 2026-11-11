# Releasing

How a QBIT firmware release is cut. GitHub Actions builds and publishes everything from the
version tag; the web flasher and devices pick the new version up from there.

## Steps

1. **Changelog:** in [`CHANGELOG.md`](../CHANGELOG.md), move the `## [Unreleased]` entries under
   `## [X.Y.Z] - YYYY-MM-DD` and add the compare link at the bottom
   (`[X.Y.Z]: https://github.com/SeanChangX/QBIT/compare/vPREV...vX.Y.Z`). Links in the section
   must be absolute: the section becomes the release notes. Check it with:

   ```sh
   python3 tools/release_notes.py notes X.Y.Z
   ```

2. **Merge** that change into `main` through a pull request. The pull request runs the release
   workflow as a dry run, so a broken build or changelog fails there, not at release time.
3. **Tag** the merged commit of `main` with an annotated tag and push it:

   ```sh
   git tag -a vX.Y.Z -m "QBIT vX.Y.Z" && git push origin vX.Y.Z
   ```

   The [release workflow](../.github/workflows/build-and-release.yml) checks that the tag has a
   changelog section, builds the firmware with the production WebSocket settings, attests the
   files' provenance and creates the release "QBIT vX.Y.Z" with the section and install steps as
   notes.
4. **Flasher and devices:** when the release workflow succeeds,
   [`deploy-gh-pages.yml`](../.github/workflows/deploy-gh-pages.yml) publishes the new images
   and `latest.json` to the web flasher. Devices check `latest.json` about every 6 hours and show
   an update notice when the version differs from theirs.

## Release Files

| File | Flash offset | Purpose |
|---|---|---|
| `bootloader.bin` | `0x0` | ESP32-C3 bootloader |
| `partitions.bin` | `0x8000` | Partition table |
| `firmware.bin` | `0x10000` | Application |
| `littlefs.bin` | `0x210000` | Device web UI (LittleFS) |
| `latest.json` | — | Version, URLs, sizes and MD5s read by the flasher and devices |
| `SHA256SUMS` | — | Checksums of all files above |

Verify a download with `sha256sum -c SHA256SUMS` and
`gh attestation verify <file> --repo SeanChangX/QBIT`.

## Rolling Back

Release tags are protected and cannot be moved or deleted. To withdraw a bad release, mark it as
a pre-release on GitHub, then run **Deploy to gh-pages branch** by hand: the flasher and
`latest.json` return to the previous release, and devices on the bad version see an update
notice for it. Fix forward with a new patch version.

## Dry Run

Run **Build and Release Firmware** by hand (Actions → Run workflow) on any branch: it builds the
newest changelog version without the production settings and uploads the files as an artifact,
without creating a release or deploying the flasher.
