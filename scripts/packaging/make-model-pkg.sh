#!/usr/bin/env bash
#
# CoreUI — Model Offline Install Bundle Generator
# ================================================
# Packages an already-downloaded model into a macOS .pkg that, when opened,
# installs the model into  ~/.coreui/models/<SUBDIR>/<ID>/  on the current
# console user's account. Mirrors the convention used by SwiftLM-installer.pkg:
#   - pkgbuild stages files under /usr/local/coreui_stage/...
#   - a postinstall script copies them to ~/.coreui/models/<SUBDIR>/<ID>/,
#     fixes ownership, strips the quarantine xattr, and cleans the staging area.
#
# This makes models distributable as fully offline "installers" — same idea as the
# engine installer, applied to Orpheus / Kokoro / Whisper (or any other model).
#
# The on-disk tree (see lib/paths.js) keeps engines/models in subdirs:
#   models/mlx/    MLX (SwiftLM) model repos
#   models/llama/  GGUF files
#   models/audio/  kokoro / whisper model repos
# Pass --subdir to match the model type.
#
# Usage:
#   scripts/packaging/make-model-pkg.sh [options] <SRC> <ID>
#
#   SRC   Path to the downloaded model directory, or a single model file
#         (.gguf / .bin / .pth / ...). Everything inside is bundled as-is.
#   ID    Model id / folder name under ~/.coreui/models/<SUBDIR>/
#         (e.g. orpheus-3b-tts-q4, kokoro-82m-tts, faster-whisper-base-stt)
#
# Options:
#   --subdir {mlx|llama|audio}   target subdir under ~/.coreui/models/ (default llama)
#   -v, --version VERSION   pkg version string (default 1.0.0)
#   -o, --output  PATH      output .pkg path (default ./dist/<ID>-installer.pkg)
#   -h, --help              show this help
#
set -euo pipefail

# Prevent cp from emitting ._ AppleDouble sidecar files into the payload
export COPYFILE_DISABLE=1

VERSION="1.0.0"
OUTPUT=""
SUBDIR="llama"

usage() {
  sed -n '3,40p' "$0" | sed 's/^# \{0,1\}//'
  echo
  echo "Usage: $0 [options] <SRC> <ID>"
  echo "  SRC   downloaded model dir or single model file"
  echo "  ID    model id (folder name under ~/.coreui/models/<SUBDIR>/)"
  echo "Options:"
  echo "  --subdir {mlx|llama|audio}  target subdir (default llama)"
  echo "  -v, --version VERSION   pkg version (default 1.0.0)"
  echo "  -o, --output  PATH      output .pkg (default ./dist/<ID>-installer.pkg)"
  echo "  -h, --help              this help"
}

POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --subdir) SUBDIR="$2"; shift 2;;
    -v|--version) VERSION="$2"; shift 2;;
    -o|--output)  OUTPUT="$2"; shift 2;;
    -h|--help)    usage; exit 0;;
    --) shift; while [[ $# -gt 0 ]]; do POSITIONAL+=("$1"); shift; done; break;;
    -*) echo "Unknown option: $1" >&2; usage >&2; exit 1;;
    *)  POSITIONAL+=("$1"); shift;;
  esac
done

case "$SUBDIR" in
  mlx|llama|audio) ;;
  *) echo "ERROR: --subdir must be one of mlx|llama|audio (got '$SUBDIR')" >&2; exit 1;;
esac

SRC="${POSITIONAL[0]:-}"
ID="${POSITIONAL[1]:-}"
if [[ -z "$SRC" || -z "$ID" ]]; then
  echo "ERROR: both <SRC> and <ID> are required." >&2
  usage >&2
  exit 1
fi
if [[ ! -e "$SRC" ]]; then
  echo "ERROR: SRC not found: $SRC" >&2
  exit 1
fi

OUTPUT="${OUTPUT:-dist/${ID}-installer.pkg}"
# pkg identifier must be a reverse-DNS-ish dotted string
PKG_ID="com.coreui.model.$(printf '%s' "$ID" | tr -C 'A-Za-z0-9.' '_')"

command -v pkgbuild >/dev/null 2>&1 || {
  echo "ERROR: pkgbuild not found. Install Xcode Command Line Tools: xcode-select --install" >&2
  exit 1
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
ROOT="$WORK/root"
STAGE="$ROOT/usr/local/coreui_stage/models/$ID"
SCRIPTS_DIR="$WORK/scripts"
mkdir -p "$STAGE" "$SCRIPTS_DIR"

# --- stage the model payload ---
if [[ -d "$SRC" ]]; then
  cp -R "$SRC"/. "$STAGE"/
else
  cp "$SRC" "$STAGE"/
fi

# Drop extended attributes (e.g. com.apple.quarantine picked up on download) and
# any stray AppleDouble sidecars so pkgbuild does not emit noisy ._ entries.
xattr -rc "$ROOT" 2>/dev/null || true
find "$ROOT" -name '._*' -delete 2>/dev/null || true

# --- postinstall: copy to the user's .coreui/models/<ID> ---
cat > "$SCRIPTS_DIR/postinstall" <<POST
#!/bin/bash
set -e
CUR_USER=\$(stat -f '%Su' /dev/console 2>/dev/null || echo "\$USER")
DEST="/Users/\$CUR_USER/.coreui/models/$SUBDIR/$ID"
mkdir -p "\$DEST"
# replace existing install of the same model id
rm -rf "\$DEST"
cp -Rf /usr/local/coreui_stage/models/$ID/. "\$DEST/"
chown -R "\$CUR_USER" "\$DEST"
chmod -R u+rwX "\$DEST"
xattr -dr com.apple.quarantine "\$DEST" 2>/dev/null || true
rm -rf /usr/local/coreui_stage
exit 0
POST
chmod +x "$SCRIPTS_DIR/postinstall"

mkdir -p "$(dirname "$OUTPUT")"
pkgbuild --root "$ROOT" \
  --identifier "$PKG_ID" \
  --version "$VERSION" \
  --install-location / \
  --scripts "$SCRIPTS_DIR" \
  "$OUTPUT"

echo "Built: $OUTPUT"
echo "  pkg id : $PKG_ID"
echo "  installs to: ~/.coreui/models/$SUBDIR/$ID/"
