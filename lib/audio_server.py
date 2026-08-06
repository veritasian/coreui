#!/usr/bin/env python3
"""
CoreUI audio serving server.

Exposes OpenAI-compatible audio endpoints backed by the appropriate local
model, selected via the COREUI_SERVE env var:

  COREUI_SERVE = orpheus  -> POST /v1/audio/speech   (TTS via orpheus-speech + llama.cpp)
  COREUI_SERVE = kokoro   -> POST /v1/audio/speech   (TTS via kokoro / kokoro-mlx)
  COREUI_SERVE = whisper  -> POST /v1/audio/transcriptions (STT via faster-whisper)

Endpoints:
  GET  /health
  POST /v1/audio/speech            {input, voice, response_format, speed} -> WAV
  POST /v1/audio/transcriptions    multipart file                         -> {text}

Heavy imports are deferred into each handler so a missing optional package
only fails the route that needs it, not the whole server.
"""
import os
import io
import sys
import json
import wave
import tempfile

from fastapi import FastAPI, Request, UploadFile, File
from fastapi.responses import Response, JSONResponse

SERVE = os.environ.get("COREUI_SERVE", "kokoro")
PORT = int(os.environ.get("COREUI_PORT", "8001"))
ORPHEUS_API = os.environ.get("COREUI_ORPHEUS_API_URL", "http://127.0.0.1:8081/v1")
KOKORO_BACKEND = os.environ.get("COREUI_KOKORO_BACKEND", "mlx")  # mlx | onnx
MODEL_PATH = os.environ.get("COREUI_MODEL_PATH", "")

app = FastAPI(title="CoreUI Audio", version="1.0")


@app.get("/health")
def health():
    return {"ok": True, "serve": SERVE}


# --------------------------------------------------------------------------
# TTS: Orpheus
# --------------------------------------------------------------------------
def _tts_orpheus(text: str, voice: str = "tara") -> bytes:
    from orpheus_tts import OrpheusModel

    # orpheus-speech uses ORPHEUS_API_URL (or COREUI_ORPHEUS_API_URL mapped by
    # the launcher) to point at a running llama.cpp/vLLM completion endpoint.
    os.environ.setdefault("ORPHEUS_API_URL", ORPHEUS_API)
    model = OrpheusModel(model_name="canopylabs/orpheus-tts-0.1-finetune-prod")
    chunks = model.generate_speech(prompt=text, voice=voice)

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(24000)
        for chunk in chunks:
            wf.writeframes(chunk)
    return buf.getvalue()


# --------------------------------------------------------------------------
# TTS: Kokoro
# --------------------------------------------------------------------------
def _tts_kokoro(text: str, voice: str = "af_heart") -> bytes:
    import soundfile as sf

    if KOKORO_BACKEND == "mlx":
        from kokoro_mlx import Kokoro

        model = Kokoro(model_path=MODEL_PATH or None)
        audio, sr = model.generate(text, voice=voice)
    else:
        from kokoro import KPipeline

        model = KPipeline(lang_code=voice[:1] or "a")
        audio, sr = model.generate(text, voice=voice)
    buf = io.BytesIO()
    sf.write(buf, audio, sr, format="WAV")
    return buf.getvalue()


# --------------------------------------------------------------------------
# STT: Whisper (faster-whisper)
# --------------------------------------------------------------------------
def _stt_whisper(audio_bytes: bytes) -> str:
    import os as _os
    from faster_whisper import WhisperModel

    model = WhisperModel(MODEL_PATH or "base", device="cpu", compute_type="int8")
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        f.write(audio_bytes)
        tmp = f.name
    try:
        segments, _ = model.transcribe(tmp)
        return "".join(s.text for s in segments)
    finally:
        try:
            _os.unlink(tmp)
        except OSError:
            pass


# --------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------
@app.post("/v1/audio/speech")
async def speech(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    text = body.get("input") or ""
    voice = body.get("voice") or ("tara" if SERVE == "orpheus" else "af_heart")
    try:
        if SERVE == "orpheus":
            wav = _tts_orpheus(text, voice)
        else:
            wav = _tts_kokoro(text, voice)
        return Response(content=wav, media_type="audio/wav")
    except Exception as e:  # surface the real error to the client
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/v1/audio/transcriptions")
async def transcribe(file: UploadFile = File(...)):
    data = await file.read()
    try:
        text = _stt_whisper(data)
        return JSONResponse({"text": text})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=PORT)
