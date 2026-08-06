// Audio model deploy layer — one-click TTS / STT serving.
//
// Three audio models are supported (see catalog/models.json, type tts/stt):
//   - orpheus : TTS. GGUF served by the existing llama.cpp engine, audio
//               tokens decoded by the bundled audio_server.py (orpheus-speech).
//   - kokoro  : TTS. Tiny 82M model; MLX backend on Apple Silicon, ONNX elsewhere.
//   - whisper : STT. faster-whisper (CTranslate2) loading a local model dir.
//
// Deploy spins up a Python venv (lazily, once) and launches a small FastAPI
// server exposing OpenAI-compatible endpoints:
//   POST /v1/audio/speech         (TTS)
//   POST /v1/audio/transcriptions (STT)
// The venv + serving process are tracked so they can be stopped cleanly and
// run alongside (not instead of) the LLM/VLM chat engine.

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { setStatus } from './status.js';
import { loadCatalog, listInstalledModels, modelLocalPath } from './model.js';
import { LLAMA_ENGINE_DIR } from './paths.js';

const exec = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ROOT = path.join(os.homedir(), '.coreui');
const VENV = path.join(ROOT, 'venv');
const AUDIO_PORT = 8001;
const ORPHEUS_LLAMA_PORT = 8081;
const SERVER_PY = path.join(__dirname, 'audio_server.py');

let group = null; // { children: child[], info }
let info = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pythonBin() {
  if (process.platform === 'win32') return path.join(VENV, 'Scripts', 'python.exe');
  return path.join(VENV, 'bin', 'python3');
}

function isAppleSilicon() {
  return process.platform === 'darwin' && process.arch === 'arm64';
}

// Create the venv once and pip-install only the packages each serve needs.
// A marker file records what was already installed so re-deploys are fast.
async function ensureVenv(packages) {
  await mkdir(VENV, { recursive: true });
  if (!existsSync(pythonBin())) {
    await exec(process.platform === 'win32' ? 'python' : 'python3', ['-m', 'venv', VENV], {
      timeout: 180000,
    });
  }
  const marker = path.join(VENV, 'installed.txt');
  let installed = '';
  try {
    installed = await readFile(marker, 'utf8');
  } catch {
    /* first run */
  }
  const need = packages.filter((p) => !installed.includes(p + '\n'));
  if (!need.length) return;
  await exec(pythonBin(), ['-m', 'pip', 'install', '--upgrade', 'pip'], { timeout: 180000 });
  // Install in small batches so a single failure is easier to diagnose.
  await exec(pythonBin(), ['-m', 'pip', 'install', ...need], { timeout: 600000 });
  await writeFile(marker, installed + need.map((p) => p + '\n').join(''));
}

async function resolveAudioModel(id) {
  const catalog = await loadCatalog();
  const cat = catalog.find((x) => x.id === id);
  if (cat && (cat.type === 'tts' || cat.type === 'stt')) return cat;
  const installed = await listInstalledModels();
  return installed.find((x) => x.id === id && (x.type === 'tts' || x.type === 'stt'));
}

export async function deployAudio({ id }) {
  const m = await resolveAudioModel(id);
  if (!m) throw new Error('未知音频模型: ' + id);

  // Stop any running audio service first (one at a time is simpler/safer).
  if (group) await stopAudio();

  const serve = m.serve;
  const env = { ...process.env, COREUI_SERVE: serve, COREUI_PORT: String(AUDIO_PORT) };
  let llamaChild = null;
  const key = 'audio:' + id;

  if (serve === 'orpheus') {
    const llamaBin = path.join(LLAMA_ENGINE_DIR, 'llama-server');
    if (!existsSync(llamaBin)) {
      setStatus(key, { phase: 'error', msg: '请先在「安装引擎」安装 llama.cpp' });
      throw new Error('llama.cpp 未安装');
    }
    const gguf = modelLocalPath(m);
    if (!existsSync(gguf)) {
      setStatus(key, { phase: 'error', msg: '请先在「安装模型」下载 ' + m.name });
      throw new Error('模型未下载');
    }
    setStatus(key, { phase: 'deploying', msg: '准备 Orpheus 运行环境（orpheus-speech）…', progress: 20 });
    await ensureVenv(['orpheus-speech', 'fastapi', 'uvicorn', 'snac', 'soundfile']);
    env.COREUI_ORPHEUS_API_URL = `http://127.0.0.1:${ORPHEUS_LLAMA_PORT}/v1`;
    setStatus(key, { phase: 'deploying', msg: '启动 llama.cpp 加载 Orpheus GGUF…', progress: 55 });
    llamaChild = spawn(llamaBin, [
      '-m', gguf, '-c', '8192', '--port', String(ORPHEUS_LLAMA_PORT), '--host', '127.0.0.1',
    ], { stdio: ['ignore', 'inherit', 'inherit'] });
    await sleep(1500);
  } else if (serve === 'kokoro') {
    const pkgs = isAppleSilicon()
      ? ['kokoro', 'misaki', 'kokoro-mlx', 'fastapi', 'uvicorn', 'soundfile']
      : ['kokoro', 'misaki', 'fastapi', 'uvicorn', 'soundfile', 'onnxruntime'];
    setStatus(key, { phase: 'deploying', msg: '准备 Kokoro 运行环境…', progress: 20 });
    await ensureVenv(pkgs);
    env.COREUI_KOKORO_BACKEND = isAppleSilicon() ? 'mlx' : 'onnx';
    env.COREUI_MODEL_PATH = modelLocalPath(m);
  } else if (serve === 'whisper') {
    setStatus(key, { phase: 'deploying', msg: '准备 Whisper 运行环境（faster-whisper）…', progress: 20 });
    await ensureVenv(['faster-whisper', 'fastapi', 'uvicorn']);
    env.COREUI_MODEL_PATH = modelLocalPath(m);
  } else {
    throw new Error('未知音频服务类型: ' + serve);
  }

  setStatus(key, { phase: 'deploying', msg: '启动音频服务…', progress: 80 });
  const child = spawn(pythonBin(), [SERVER_PY], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', (d) => console.error('[audio-server]', d.toString()));
  child.on('exit', () => {
    if (group && group.children.includes(child)) {
      console.log('[audio] server exited, stopping group');
      stopAudio().catch(() => {});
    }
  });

  group = {
    children: [llamaChild, child].filter(Boolean),
    info: {
      serve,
      modelId: id,
      modelName: m.name,
      endpoint: `http://127.0.0.1:${AUDIO_PORT}`,
      port: AUDIO_PORT,
    },
  };
  info = group.info;
  setStatus(key, { phase: 'done', msg: `${m.name} 已部署 · ${group.info.endpoint}`, progress: 100 });
  return group.info;
}

export async function stopAudio() {
  if (!group) return { stopped: false, msg: '没有运行中的音频服务' };
  const pids = group.children.map((c) => c.pid).filter(Boolean);
  group.children.forEach((c) => {
    try {
      c.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  });
  await sleep(1500);
  group.children.forEach((c) => {
    try {
      process.kill(c.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  });
  group = null;
  info = null;
  return { stopped: true, pids };
}

export function getAudioService() {
  if (!group) return null;
  try {
    group.children.forEach((c) => process.kill(c.pid, 0));
    return info;
  } catch {
    group = null;
    info = null;
    return null;
  }
}
