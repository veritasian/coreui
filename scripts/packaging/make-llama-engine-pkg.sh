#!/usr/bin/env bash
#
# CoreUI — Llama.cpp Engine Offline Install Bundle Generator
# ==========================================================
# Packages the locally-installed llama.cpp engine (llama-server + its shared
# libraries) into a macOS .pkg that, when opened, installs the engine into
# ~/.coreui/engine/llama/ on the current console user's account.
#
# Mirrors the convention used by SwiftLM-installer.pkg and make-model-pkg.sh:
#   - pkgbuild stages files under /usr/local/coreui_stage/engine/...
#   - a postinstall script copies them to ~/.coreui/engine/, fixes ownership,
#     marks binaries + dylibs executable, strips the quarantine xattr, and
#     cleans the staging area.
#
# Only the llama.cpp artefacts are bundled. SwiftLM (swiftlm binary + mlx.metallib)
# is deliberately excluded so the two engines stay in separate installers.
#
# Usage:
#   scripts/packaging/make-llama-engine-pkg.sh [options] [SRC_ENGINE_DIR]
#
#   SRC_ENGINE_DIR  Directory that currently holds llama-server + lib*.dylib
#                   (default: ~/.coreui/engine/llama)
#
# Options:
#   -v, --version VERSION   pkg version string (default 1.0.0)
#   -o, --output  PATH      output .pkg path (default ./dist/LlamaCpp-engine-installer.pkg)
#   -h, --help              show this help
#
set -euo pipefail

# Prevent cp from emitting ._ AppleDouble sidecar files into the payload
export COPYFILE_DISABLE=1

VERSION="1.0.0"
OUTPUT=""
ID="llamacpp"

usage() {
  sed -n '3,40p' "$0" | sed 's/^# \{0,1\}//'
  echo
  echo "Usage: $0 [options] [SRC_ENGINE_DIR]"
  echo "Options:"
  echo "  -v, --version VERSION   pkg version (default 1.0.0)"
  echo "  -o, --output  PATH      output .pkg (default ./dist/LlamaCpp-engine-installer.pkg)"
  echo "  -h, --help              this help"
}

POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -v|--version) VERSION="$2"; shift 2;;
    -o|--output)  OUTPUT="$2"; shift 2;;
    -h|--help)    usage; exit 0;;
    --) shift; while [[ $# -gt 0 ]]; do POSITIONAL+=("$1"); shift; done; break;;
    -*) echo "Unknown option: $1" >&2; usage >&2; exit 1;;
    *)  POSITIONAL+=("$1"); shift;;
  esac
done

SRC="${POSITIONAL[0]:-}"
SRC="${SRC:-$HOME/.coreui/engine/llama}"
if [[ ! -d "$SRC" ]]; then
  echo "ERROR: engine dir not found: $SRC" >&2
  exit 1
fi
if [[ ! -x "$SRC/llama-server" ]]; then
  echo "ERROR: llama-server not found/executable in $SRC" >&2
  exit 1
fi

OUTPUT="${OUTPUT:-dist/LlamaCpp-engine-installer.pkg}"
PKG_ID="com.coreui.engine.llamacpp"

command -v pkgbuild >/dev/null 2>&1 || {
  echo "ERROR: pkgbuild not found. Install Xcode Command Line Tools: xcode-select --install" >&2
  exit 1
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
ROOT="$WORK/root"
STAGE="$ROOT/usr/local/coreui_stage/engine"
SCRIPTS_DIR="$WORK/scripts"
mkdir -p "$STAGE" "$SCRIPTS_DIR"

# --- stage only the llama.cpp artefacts (exclude SwiftLM + mlx.metallib) ---
# -X : do not copy extended attributes (prevents pkgbuild from emitting ._ sidecars)
cp -X "$SRC/llama-server" "$STAGE"/
# shared libraries: ggml / llama / mtmd (all variants: .dylib, .0.dylib, .0.0.x.dylib)
for pat in 'libggml*.dylib' 'libllama*.dylib' 'libmtmd*.dylib'; do
  # shellcheck disable=SC2086
  for f in $SRC/$pat; do
    [[ -e "$f" ]] || continue
    cp -X "$f" "$STAGE"/
  done
done

echo "Staged $(ls -1 "$STAGE" | wc -l | tr -d ' ') engine files:"
ls -1 "$STAGE" | sed 's/^/  /'

# Drop extended attributes + stray AppleDouble sidecars.
xattr -rc "$ROOT" 2>/dev/null || true
find "$ROOT" -name '._*' -delete 2>/dev/null || true

# --- postinstall: copy to the user's .coreui/engine/, mark exec, fix owner ---
cat > "$SCRIPTS_DIR/postinstall" <<POST
#!/bin/bash
set -e
CUR_USER=\$(stat -f '%Su' /dev/console 2>/dev/null || echo "\$USER")
DEST="/Users/\$CUR_USER/.coreui/engine/llama"
mkdir -p "\$DEST"
# drop any AppleDouble sidecars from the staging area before installing
find /usr/local/coreui_stage -name '._*' -delete 2>/dev/null || true
# copy llama.cpp artefacts (do not touch SwiftLM / mlx.metallib already present)
cp -Rf /usr/local/coreui_stage/engine/. "\$DEST/"
# belt-and-suspenders: remove any ._ leftovers in the destination
find "\$DEST" -name '._*' -delete 2>/dev/null || true
chown -R "\$CUR_USER" "\$DEST"
chmod -R u+rwX "\$DEST"
# ensure the server binary + every dylib is executable
chmod 755 "\$DEST/llama-server" 2>/dev/null || true
for lib in "\$DEST"/libggml*.dylib "\$DEST"/libllama*.dylib "\$DEST"/libmtmd*.dylib; do
  chmod 755 "\$lib" 2>/dev/null || true
done
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
echo "  installs to: ~/.coreui/engine/llama/ (llama-server + libggml/libllama/libmtmd dylibs)"
