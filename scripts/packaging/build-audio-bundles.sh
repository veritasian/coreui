#!/usr/bin/env bash
#
# Build the three audio-model offline install bundles (Orpheus / Kokoro / Whisper)
# using make-model-pkg.sh. Downloads each model from HuggingFace, then packages it.
#
set -uo pipefail
export COPYFILE_DISABLE=1

HF=/Users/andy/Library/Python/3.9/bin/hf
COREUI=~/Developer/coreui
GEN="$COREUI/scripts/packaging/make-model-pkg.sh"
STAGE=$(mktemp -d)
OUT="$COREUI/dist"
LOG="$OUT/build-audio-bundles.log"
mkdir -p "$OUT"
: > "$LOG"

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }

build_one() {
  local src="$1" id="$2" out="$3"
  log "=== Packaging $id from $src ==="
  if bash "$GEN" "$src" "$id" -o "$out" >>"$LOG" 2>&1; then
    log "OK  -> $out ($(du -h "$out" | cut -f1))"
  else
    log "FAIL -> $id (see $LOG)"
  fi
}

# 1) Orpheus 3B TTS (single GGUF repo)
log ">>> Downloading Orpheus-3b-FT-Q4_K_M.gguf"
"$HF" download --local-dir "$STAGE/orpheus" lex-au/Orpheus-3b-FT-Q4_K_M.gguf >>"$LOG" 2>&1 \
  && build_one "$STAGE/orpheus" orpheus-3b-tts-q4 "$OUT/orpheus-3b-tts-q4-installer.pkg" \
  || log "FAIL -> orpheus download"

# 2) Kokoro 82M TTS (weights + voices repo)
log ">>> Downloading Kokoro-82M"
"$HF" download --local-dir "$STAGE/kokoro" hexgrad/Kokoro-82M >>"$LOG" 2>&1 \
  && build_one "$STAGE/kokoro" kokoro-82m-tts "$OUT/kokoro-82m-tts-installer.pkg" \
  || log "FAIL -> kokoro download"

# 3) faster-whisper base STT (CTranslate2 repo)
log ">>> Downloading faster-whisper-base"
"$HF" download --local-dir "$STAGE/whisper" Systran/faster-whisper-base >>"$LOG" 2>&1 \
  && build_one "$STAGE/whisper" faster-whisper-base-stt "$OUT/faster-whisper-base-stt-installer.pkg" \
  || log "FAIL -> whisper download"

log "=== ALL DONE ==="
ls -la "$OUT"/*-installer.pkg 2>/dev/null | tee -a "$LOG"
