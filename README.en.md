# CoreUI

**English** | [中文](README.md)

**All-in-one local LLM deployment manager.** Complete four guided steps in your browser — **Detect system → Install engine → Install model → Run model** — and you are serving an LLM / TTS / STT endpoint on your own machine.

- **One-stop llama engine**: built-in management for [llama.cpp](https://github.com/ggml-org/llama.cpp) (GGUF runtime) — detect, install, test, and remove with a few clicks.
- **One-stop SwiftLM engine**: built-in management for [SwiftLM](https://github.com/SharpAI/SwiftLM) (Apple MLX-native inference server) — plug-and-play on Apple Silicon.
- **Local-first deployment**: zero third-party dependencies, fully local. Models, prompts, and conversations never leave your computer.

> Keywords: local LLM deployment · one-stop llama engine · one-stop SwiftLM engine · local AI · Apple MLX · GGUF

**Zero dependencies, purely local.** Backend is a Node.js native HTTP server; frontend is a single HTML page. No telemetry, no server-side storage.

## Features

- **Guided four-step workflow**: detect → engine → model → run, with start / stop / switch per model.
- **Dual engines**:
  - [`llama.cpp`](https://github.com/ggml-org/llama.cpp) — cross-platform GGUF inference runtime (CPU / Metal / CUDA).
  - [`SwiftLM`](https://github.com/SharpAI/SwiftLM) — Apple Silicon MLX-native inference server, OpenAI-compatible, consumes MLX weights.
- **Per-model dedicated port (8200–8799)**: each model gets a stable port; switching models auto-stops the previous one.
- **Official-source downloads**: engines are fetched from official GitHub release pages; models come from Hugging Face.
- **Local-first**: no telemetry, no server retention — audio and chat data live only in the browser and on the local disk.

## Installing CoreUI (the tool itself)

1. **Install Node.js** (≥ 18, LTS) from [nodejs.org](https://nodejs.org).
2. **Get the code**: `git clone https://github.com/veritasian/coreui.git`, or click **Code → Download ZIP** on GitHub and extract.
3. **Skip dependency install**: the project has zero third-party dependencies — no `npm install` needed.
4. **Start**:

   ```bash
   node server.js              # default port 5173
   PORT=8899 node server.js    # or pick a port (recommended, avoids dev-server conflicts)
   ```

5. **Open your browser** at `http://localhost:8899` and follow the four steps on the left.

## Platform support

| Platform | Manager | llama.cpp engine | SwiftLM engine |
|---|---|---|---|
| macOS (Apple Silicon) | ✅ | ✅ Metal-accelerated | ✅ MLX-native |
| macOS (Intel) | ✅ | ✅ CPU | ❌ |
| Windows 10 / 11 | ✅ | ✅ CPU (CUDA requires manual driver/toolchain setup) | ❌ |
| Linux | ✅ | ✅ CPU / CUDA | ❌ |

- **The manager itself** (Node backend + browser UI) runs on any system with Node ≥ 18; detection natively supports macOS / Windows / Linux.
- **llama.cpp** works on all platforms: Metal on Apple Silicon, CUDA on NVIDIA GPUs, CPU fallback (pick small models for CPU-only setups).
- **SwiftLM** requires Apple Silicon (macOS arm64) and is not available on Windows / Linux.
- **Engine binaries**: use the **Download prebuilt** button on each engine card (fetched from the official GitHub release page), or place a prebuilt binary manually into `~/.coreui/engine/<subdir>`.

## Quick start

1. **Detect** — click "Start detection" to see what your machine can run.
2. **Install engine** — click "Download prebuilt" on the engine card (from the official GitHub release), then click "Test" to verify.
3. **Install model** — download a model yourself, then drop the folder / `.gguf` file into the matching directory:

   | Model type | Directory |
   |---|---|
   | GGUF (llama.cpp) | `~/.coreui/models/llama/` |
   | MLX (SwiftLM) | `~/.coreui/models/mlx/` |
   | Audio models (TTS / STT) | `~/.coreui/models/audio/` |

4. **Run** — find the model under "Installed", click **Start**, and the page shows a local endpoint (e.g. `http://127.0.0.1:8234/v1`, OpenAI-compatible) that other applications can connect to.

> Model selection: for engine/model recommendations by RAM and chipset, see the system-config table inside the app's built-in guide.

## Engine parameters

CoreUI applies sensible defaults automatically — most setups need no tuning. The following are the underlying engine flags if you want to adjust them.

| Parameter | Engine | Description |
|---|---|---|
| `--model` | Both | Model file path (passed automatically by CoreUI) |
| `--port` | Both | Serving port. CoreUI assigns a **stable per-model port (8200–8799)** — the same model always uses the same port |
| `--ctx-size` (`-c`) | llama.cpp | Context length in tokens. Longer = more conversation memory, higher memory usage; 8K–32K is the common range |
| `--threads` (`-t`) | llama.cpp | CPU inference threads (defaults to all cores) |
| `--n-gpu-layers` (`-ngl`) | llama.cpp | Layers offloaded to GPU. Set to max (999) on Apple Silicon / NVIDIA for full GPU inference; lower it if VRAM is tight |
| `--vision` | SwiftLM | Enable multimodal (image input) |
| `--audio` | SwiftLM | Enable audio input / output |
| `temperature` (API) | Both | Sampling temperature. Lower = more conservative; higher = more creative. Default ~0.7 |

## Directory structure

```
coreui/
├── server.js            # Zero-dependency Node backend (HTTP server + REST API)
├── lib/                 # Core logic
│   ├── paths.js         # Managed-directory constants (engine/mlx, engine/llama, models/...)
│   ├── engine.js        # Engine status / install / test / remove; model start (per-model ports)
│   ├── model.js         # Model-directory scan, install, installed list
│   ├── detect.js        # System detection and recommendations
│   ├── audio.js         # TTS / STT audio service (llama.cpp + Python)
│   ├── hf.js / download.js / status.js
├── catalog/models.json  # Built-in model catalog
└── public/              # Frontend single-page app (index.html / app.js / styles.css)
```

## API overview

| Endpoint | Method | Description |
|---|---|---|
| `/api/detect` | GET | System detection (chip / RAM / disk / recommendation) |
| `/api/engine` | GET | Engine installation status |
| `/api/engine/install` | POST | Install engine (`{type, mode: download}`) |
| `/api/engine/test` | POST | Test whether an engine launches (`{type}`) |
| `/api/engine/remove` | POST | Remove engine (`{type}`) |
| `/api/models` | GET | Built-in model catalog |
| `/api/model/installed` | GET | Installed models (scans the three subdirectories) |
| `/api/model/start` / `stop` | POST | Start / stop a model (`{id}`) |
| `/api/model/remove` | POST | Remove a model (`{id}`) |
| `/api/status` | GET | Install progress / runtime status |
| `/api/audio/*` | — | Audio service deploy / status / stop |

## Development

- Environment: Node ≥ 18 (ESM).
- Syntax check: `node --check server.js lib/*.js public/app.js`.
- No third-party runtime dependencies — no `npm install`.
- Development summary (architecture, design decisions, bug-fix log, lessons learned): see [docs/development-summary.md](docs/development-summary.md).

## Acknowledgements

- [llama.cpp](https://github.com/ggml-org/llama.cpp) — GGUF inference engine and `llama-server`, CPU / Metal / CUDA acceleration.
- [SwiftLM](https://github.com/SharpAI/SwiftLM) — Apple MLX-native inference service with an OpenAI-compatible interface.
- [Apple MLX](https://github.com/ml-explore/mlx) — machine learning framework for Apple Silicon.
- [Hugging Face](https://huggingface.co) — model downloads and the built-in catalog data source.
- All contributors to the GGUF format and the llama.cpp ecosystem.

## License

MIT
