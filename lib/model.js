// Model catalog + downloader — the "install model" step.
//
// Two data sources:
//   1. Curated catalog (catalog/models.json) — shown in "Best Match".
//   2. HuggingFace search results — installed on demand from "Search".
//
// Storage layout under ~/.coreui/models (tree structure):
//   - mlx/    : SwiftLM / MLX model repos (whole repo trees).
//   - llama/  : GGUF models (.gguf files, incl. vlm-projector + orpheus).
//   - audio/  : kokoro / whisper model repos (whole repo trees).
//
// All path derivation lives in ./paths.js so the layout is defined once.

import path from 'node:path';
import { mkdir, stat, readdir, rm, unlink } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setStatus } from './status.js';
import { downloadStream } from './download.js';
import { resolveGGUF } from './hf.js';
import {
  MLX_MODELS_DIR,
  LLAMA_MODELS_DIR,
  AUDIO_MODELS_DIR,
} from './paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG = path.join(__dirname, '..', 'catalog', 'models.json');

export async function loadCatalog() {
  const raw = await readFile(CATALOG, 'utf8');
  return JSON.parse(raw).models;
}

// Kept for backward compatibility with callers that referenced the old flat
// root. Everything new should use the explicit *_MODELS_DIR helpers.
export function modelsDir() {
  return LLAMA_MODELS_DIR;
}

function safeId(repo) {
  return repo.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

// Pick the on-disk subdir a catalog/HF model belongs in.
function modelInstallDir(m) {
  if (m.engine === 'swiftlm') return MLX_MODELS_DIR;
  if (m.serve === 'kokoro' || m.serve === 'whisper') return AUDIO_MODELS_DIR;
  return LLAMA_MODELS_DIR; // llama.cpp GGUF (incl. vlm-projector, orpheus)
}

function swiftlmLocalPath(hfId) {
  return path.join(MLX_MODELS_DIR, hfId.replace(/\//g, '__'));
}

function ggufPath(fileOrRepo) {
  return path.join(LLAMA_MODELS_DIR, fileOrRepo.replace(/\//g, '__') + '.gguf');
}

// Unified local path for any catalog/HF model:
//   - swiftlm : MLX repo dir  (models/mlx/<hf with / -> __>)
//   - kokoro / whisper : HF repo dir  (models/audio/<repo with / -> __>)
//   - llama.cpp GGUF : single .gguf  (models/llama/<file or repo.gguf>)
function modelLocalPath(m) {
  if (m.engine === 'swiftlm') return swiftlmLocalPath(m.hf || m.repo);
  if (m.serve === 'kokoro' || m.serve === 'whisper')
    return path.join(AUDIO_MODELS_DIR, (m.repo || m.hf).replace(/\//g, '__'));
  // GGUF — catalog uses m.file, HF installs use m.repo + ".gguf"
  const fname = m.file || (m.repo ? m.repo.replace(/\//g, '__') + '.gguf' : m.hf.replace(/\//g, '__') + '.gguf');
  return path.join(LLAMA_MODELS_DIR, fname);
}
export { modelLocalPath };

async function dirSize(dir) {
  let total = 0;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) total += await dirSize(p);
      else total += (await stat(p)).size;
    }
  } catch {
    /* ignore */
  }
  return total;
}

function statSyncSafe(p) {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

// ---------- catalog models (Best Match) ----------

export async function listModels() {
  const models = await loadCatalog();
  return Promise.all(
    models.map(async (m) => {
      const local = modelLocalPath(m);
      const installed = existsSync(local);
      const isDir = installed && statSync(local).isDirectory();
      return {
        ...m,
        installed,
        localPath: local,
        localSizeMB: installed
          ? Math.round((isDir ? await dirSize(local) : statSyncSafe(local)) / 1e6)
          : 0,
      };
    })
  );
}

// ---------- installed models (filesystem scan over all 3 subdirs) ----------

export async function listInstalledModels() {
  const catalog = await loadCatalog();
  const models = [];

  // [dir, kind] — kind drives classification.
  const scans = [
    [MLX_MODELS_DIR, 'mlx'],
    [LLAMA_MODELS_DIR, 'llama'],
    [AUDIO_MODELS_DIR, 'audio'],
  ];

  for (const [dir, kind] of scans) {
    await mkdir(dir, { recursive: true });
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);

      if (kind === 'mlx') {
        if (!e.isDirectory()) continue;
        const repo = e.name.replace(/__/g, '/');
        const cat = catalog.find((c) => c.hf === repo || c.repo === repo);
        const size = await dirSize(p);
        models.push({
          id: safeId(repo),
          repo,
          name: cat?.name || repo,
          engine: 'swiftlm',
          format: 'mlx',
          type: cat?.type || 'llm',
          installed: true,
          localSizeMB: Math.round(size / 1e6),
          localPath: p,
        });
      } else if (kind === 'llama') {
        if (e.isDirectory()) {
          const repo = e.name.replace(/__/g, '/');
          const cat = catalog.find((c) => c.repo === repo || c.hf === repo);
          const size = await dirSize(p);
          models.push({
            id: safeId(repo),
            repo,
            name: cat?.name || repo,
            engine: 'llama.cpp',
            format: 'gguf',
            type: cat?.type || 'llm',
            serve: cat?.serve,
            installed: true,
            localSizeMB: Math.round(size / 1e6),
            localPath: p,
          });
        } else if (e.name.endsWith('.gguf')) {
          const name = e.name.replace(/\.gguf$/i, '');
          const repo = name.replace(/__/g, '/');
          const cat = catalog.find(
            (c) => c.repo === repo || (c.file && c.file.replace(/\.gguf$/i, '') === name)
          );
          const size = statSyncSafe(p);
          models.push({
            id: safeId(repo),
            repo,
            name: cat?.name || repo,
            engine: 'llama.cpp',
            format: 'gguf',
            type: cat?.type || 'llm',
            serve: cat?.serve,
            installed: true,
            localSizeMB: Math.round(size / 1e6),
            localPath: p,
          });
        }
      } else {
        // audio
        if (!e.isDirectory()) continue;
        const repo = e.name.replace(/__/g, '/');
        const cat = catalog.find((c) => c.repo === repo);
        const size = await dirSize(p);
        models.push({
          id: safeId(repo),
          repo,
          name: cat?.name || repo,
          engine: cat?.serve || 'audio',
          format: 'audio',
          type: cat?.type || 'tts',
          serve: cat?.serve,
          installed: true,
          localSizeMB: Math.round(size / 1e6),
          localPath: p,
        });
      }
    }
  }
  return models.sort((a, b) => b.localSizeMB - a.localSizeMB);
}

export async function removeModel(id) {
  const catalog = await loadCatalog();
  const catalogEntry = catalog.find((x) => x.id === id);
  if (catalogEntry) {
    const p = modelLocalPath(catalogEntry);
    const isDir = existsSync(p) && statSync(p).isDirectory();
    if (isDir) await rm(p, { recursive: true, force: true });
    else await unlink(p).catch(() => {});
    return { removed: true, id };
  }

  // Try to match an installed model by id.
  const installed = await listInstalledModels();
  const m = installed.find((x) => x.id === id);
  if (!m) throw new Error('未找到模型: ' + id);
  if (m.engine === 'swiftlm' || m.serve === 'kokoro' || m.serve === 'whisper') {
    await rm(m.localPath, { recursive: true, force: true });
  } else {
    await unlink(m.localPath).catch(() => {});
  }
  return { removed: true, id };
}

// ---------- install from catalog ----------

export async function installModel(id, proxy) {
  const models = await loadCatalog();
  const m = models.find((x) => x.id === id);
  if (!m) {
    setStatus('model:' + id, { phase: 'error', msg: '未知模型: ' + id });
    throw new Error('未知模型: ' + id);
  }
  await mkdir(modelInstallDir(m), { recursive: true });

  if (m.engine === 'swiftlm') {
    return downloadRepo(m.hf, swiftlmLocalPath(m.hf), id, proxy);
  }

  if (m.serve === 'kokoro' || m.serve === 'whisper') {
    return downloadRepo(m.repo, modelLocalPath(m), id, proxy);
  }

  const dest = path.join(LLAMA_MODELS_DIR, m.file);
  setStatus('model:' + id, { phase: 'downloading', msg: `下载 ${m.name}…`, progress: 0 });
  await downloadStream(
    m.url,
    dest,
    (received, total) =>
      setStatus('model:' + id, {
        phase: 'downloading',
        progress: total ? Math.round((received / total) * 100) : null,
        msg: `${Math.round(received / 1e6)} / ${Math.round(total / 1e6)} MB`,
      }),
    proxy
  );
  setStatus('model:' + id, { phase: 'done', msg: `已安装 ${m.name}`, progress: 100 });
  return { id, path: dest };
}

// ---------- install from HF search ----------

export async function installHFModel({ repo, engine, type = 'llm', proxy }) {
  const id = safeId(repo);
  const dir = engine === 'swiftlm' ? MLX_MODELS_DIR : LLAMA_MODELS_DIR;
  await mkdir(dir, { recursive: true });

  if (engine === 'swiftlm') {
    const dest = swiftlmLocalPath(repo);
    await downloadRepo(repo, dest, id, proxy);
    return { id, repo, path: dest };
  }

  // GGUF
  const info = await resolveGGUF(repo);
  const dest = ggufPath(repo);
  setStatus('model:' + id, { phase: 'downloading', msg: `下载 ${repo}…`, progress: 0 });
  await downloadStream(
    info.url,
    dest,
    (received, total) =>
      setStatus('model:' + id, {
        phase: 'downloading',
        progress: total ? Math.round((received / total) * 100) : null,
        msg: `${Math.round(received / 1e6)} / ${Math.round(total / 1e6)} MB`,
      }),
    proxy
  );
  setStatus('model:' + id, { phase: 'done', msg: `已安装 ${repo}`, progress: 100 });
  return { id, repo, path: dest };
}

// ---------- repo downloader ----------

async function downloadRepo(hfId, dest, id, proxy) {
  await mkdir(dest, { recursive: true });
  const treeUrl = `https://huggingface.co/api/models/${hfId}/tree/main`;
  const treeRes = await fetch(treeUrl);
  if (!treeRes.ok) throw new Error(`无法获取模型清单: HTTP ${treeRes.status}`);
  const files = (await treeRes.json()).filter((f) => f.type === 'file');
  const total = files.reduce((a, f) => a + (f.size || 0), 0);
  let received = 0;

  setStatus('model:' + id, { phase: 'downloading', msg: `拉取 ${hfId} 清单（${files.length} 个文件）…`, progress: 0 });

  for (const f of files) {
    const url = `https://huggingface.co/${hfId}/resolve/main/${f.path}`;
    const fpath = path.join(dest, f.path);
    await mkdir(path.dirname(fpath), { recursive: true });
    const r = await downloadStream(url, fpath, null, proxy);
    received += r.received;
    setStatus('model:' + id, {
      phase: 'downloading',
      progress: total ? Math.round((received / total) * 100) : null,
      msg: `${Math.round(received / 1e6)} / ${Math.round(total / 1e6)} MB`,
    });
  }
  setStatus('model:' + id, { phase: 'done', msg: `已安装 ${hfId}`, progress: 100 });
  return { id, path: dest };
}
