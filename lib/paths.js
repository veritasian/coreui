// Single source of truth for CoreUI's on-disk layout (tree structure).
//
// Layout under ~/.coreui:
//   engine/
//     mlx/     -> SwiftLM engine (swiftlm binary + mlx.metallib)
//     llama/   -> llama.cpp engine (llama-server + libggml*/libllama*/libmtmd* dylibs)
//   models/
//     mlx/     -> SwiftLM / MLX model repos (whole repo trees)
//     llama/   -> GGUF models (.gguf files)
//     audio/   -> kokoro / whisper / orpheus model repos
//
// Keeping every path derivation here means a layout change touches one file.

import os from 'node:os';
import path from 'node:path';

const ROOT = path.join(os.homedir(), '.coreui');
export const ENGINE_DIR = path.join(ROOT, 'engine');
export const MODELS_DIR = path.join(ROOT, 'models');

// Engine subdirs
export const MLX_ENGINE_DIR = path.join(ENGINE_DIR, 'mlx');
export const LLAMA_ENGINE_DIR = path.join(ENGINE_DIR, 'llama');

// Model subdirs
export const MLX_MODELS_DIR = path.join(MODELS_DIR, 'mlx');
export const LLAMA_MODELS_DIR = path.join(MODELS_DIR, 'llama');
export const AUDIO_MODELS_DIR = path.join(MODELS_DIR, 'audio');

// ---------- engine helpers ----------

export function engineDirFor(type) {
  return type === 'swiftlm' ? MLX_ENGINE_DIR : LLAMA_ENGINE_DIR;
}

export function swiftlmBinary() {
  return path.join(MLX_ENGINE_DIR, 'swiftlm');
}

export function llamaBinary() {
  return path.join(LLAMA_ENGINE_DIR, 'llama-server');
}

export function mlxMetallib() {
  return path.join(MLX_ENGINE_DIR, 'mlx.metallib');
}

// ---------- model helpers ----------

// Map a model's engine field to its model subdir.
export function modelDirForEngine(engine) {
  if (engine === 'swiftlm') return MLX_MODELS_DIR;
  if (engine === 'llama.cpp') return LLAMA_MODELS_DIR;
  return AUDIO_MODELS_DIR;
}

// Map a model's serve field (kokoro / whisper / orpheus …) to its model subdir.
export function modelDirForServe(serve) {
  if (serve === 'kokoro' || serve === 'whisper') return AUDIO_MODELS_DIR;
  return LLAMA_MODELS_DIR; // orpheus is a GGUF served by llama.cpp
}

// All model subdirs, for filesystem scans.
export function modelsSubdirs() {
  return [MLX_MODELS_DIR, LLAMA_MODELS_DIR, AUDIO_MODELS_DIR];
}
