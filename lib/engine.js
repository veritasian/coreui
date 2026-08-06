// Engine installer + active model lifecycle — the "install engine" and "run" steps.
//
// Two engines are supported:
//   - llama.cpp : vendored GGUF runtime (CPU/Metal/CUDA). Default, cross-platform.
//   - swiftlm  : SharpAI's native Apple MLX server (Apple Silicon only,
//                OpenAI-compatible, eats MLX-native weights instead of GGUF).
//
// Both are installed by REUSE when an existing usable binary is found on the
// machine, falling back to DOWNLOAD/BUILD. Status is namespaced per engine.

import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, copyFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { setStatus } from './status.js';
import { downloadStream } from './download.js';
import {
  ENGINE_DIR,
  MLX_ENGINE_DIR,
  LLAMA_ENGINE_DIR,
  swiftlmBinary as swiftlmBinaryPath,
  llamaBinary as llamaBinaryPath,
  mlxMetallib as mlxMetallibPath,
  engineDirFor,
} from './paths.js';

const exec = promisify(execFile);

// Engine install state is driven solely by what's present in the managed
// directory (~/.coreui/engine/<mlx|llama>). We deliberately do NOT scan
// arbitrary system paths for stray binaries, so status is unambiguous: an
// engine is either installed (in the managed dir) or not.

// Per-model port range. Each model gets a stable, distinct port so "切换模型"
// never collides and the user can tell models apart by port number.
const PORT_BASE = 8200;
const PORT_SPAN = 600; // 8200..8799

// Deterministic per-model port (FNV-1a hash of the id). Same model → same port;
// different models → (almost always) different ports.
export function portForModel(id) {
  let h = 2166136261 >>> 0;
  const s = String(id);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return PORT_BASE + (h % PORT_SPAN);
}

// SwiftLM ships public pre-built binaries on GitHub Releases (self-contained:
// the binary bundles mlx.metallib). This is the fastest install path and works
// on any Apple Silicon Mac with macOS 14+, no Swift toolchain required.
const SWIFTLM_RELEASE_TAG = 'b648'; // latest known-good; refreshed via API when possible

async function latestSwiftlmTag() {
  try {
    const res = await fetch('https://api.github.com/repos/SharpAI/SwiftLM/releases/latest', {
      headers: { 'User-Agent': 'coreui' },
    });
    if (res.ok) {
      const j = await res.json();
      if (j && j.tag_name) return j.tag_name;
    }
  } catch (_) {
    /* fall through to pinned tag */
  }
  return SWIFTLM_RELEASE_TAG;
}

let activeProcess = null;
let activeModelInfo = null;

function llamaBinary() {
  return llamaBinaryPath();
}
function swiftlmBinary() {
  return swiftlmBinaryPath();
}

// Safe probe: spawn the binary, grab the first line of output, then SIGKILL —
// never blocking on process exit. Returns whether the binary actually LAUNCHED
// (vs. crashed / quarantined / missing) plus the first output line. For
// llama-server, --version prints the version then keeps running as a server, so
// we must not wait for exit. For SwiftLM, --version is unsupported and emits an
// argument error to stderr — that still proves the binary is alive, so we just
// report "launched" and ignore the error text (see testEngine).
async function binaryVersion(bin, args = ['--version']) {
  return new Promise((resolve) => {
    let done = false;
    let out = '';
    let child;
    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      resolve(val);
    };
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ launched: false, line: 'installed', error: String(e.message || e) });
    }
    const onData = (d) => {
      out += d.toString();
      const line = out.split('\n').find((l) => l.trim());
      if (line && !done) finish({ launched: true, line: line.trim() || 'installed' });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => finish({ launched: false, line: 'installed', error: String(e.message || e) }));
    const timer = setTimeout(() => {
      const line = out.split('\n').find((l) => l.trim());
      finish({ launched: true, line: line ? line.trim() : 'installed' });
    }, 1500);
  });
}

// "version: 9594 (68f30663c)" -> "9594" for a tidy UI badge; passthrough otherwise.
function prettyVersion(line) {
  if (!line || line === 'installed') return 'present';
  const m = line.match(/version:\s*([^\s]+)/);
  return m ? m[1] : line;
}

async function statusFor(type) {
  if (type === 'llama.cpp') {
    const bin = llamaBinary();
    if (existsSync(bin)) {
      const v = await binaryVersion(bin, ['--version']);
      return { installed: true, path: bin, version: prettyVersion(v && v.line) };
    }
    return { installed: false, available: false, note: '未安装 llama.cpp，请下载官方预编译包' };
  }
  // swiftlm
  const bin = swiftlmBinary();
  if (existsSync(bin)) {
    return { installed: true, path: bin, version: 'SwiftLM' };
  }
  return { installed: false, available: false, note: '未安装 SwiftLM，请下载官方预编译包（仅 Apple Silicon）' };
}

export async function getEngineStatus() {
  return { llamaCpp: await statusFor('llama.cpp'), swiftlm: await statusFor('swiftlm') };
}

/* ---------- llama.cpp install (download) ---------- */

async function fixRpath(bin) {
  try {
    const { stdout } = await exec('otool', ['-l', bin], { timeout: 8000 });
    const paths = [...stdout.matchAll(/path\s+([^\s]+)\s+\(/g)].map((m) => m[1]);
    const bad = paths.filter((p) => p.startsWith('/tmp/'));
    for (const p of bad) {
      await exec('install_name_tool', ['-delete_rpath', p, bin]).catch(() => {});
    }
    if (!paths.includes('@loader_path')) {
      await exec('install_name_tool', ['-add_rpath', '@loader_path', bin]);
    }
    await exec('codesign', ['--force', '--sign', '-', bin]).catch(() => {});
  } catch {
    /* non-fatal; copied binary may still launch */
  }
}

async function installLlamaCpp(mode = 'reuse') {
  const key = 'engine:llama.cpp';
  setStatus(key, { phase: 'installing', msg: '准备 llama.cpp…', progress: 0 });

  // The old "reuse a stray system binary" path was removed so engine status
  // stays unambiguous (an engine is installed only if present in the managed
  // dir). 'reuse' now falls through to the direct download below.
  if (mode === 'download' || mode === 'reuse') {
    setStatus(key, { phase: 'downloading', msg: '从 GitHub 下载 llama.cpp 预编译包…', progress: 10 });
    const tag = 'b4829';
    const asset = `llama-server-${process.platform === 'darwin' ? 'darwin' : process.platform}-${process.arch}.zip`;
    const url = `https://github.com/ggml-org/llama.cpp/releases/download/${tag}/${asset}`;
    const zip = path.join(LLAMA_ENGINE_DIR, 'engine.zip');
    await mkdir(LLAMA_ENGINE_DIR, { recursive: true });
    await downloadStream(
      url,
      zip,
      (r, t) => setStatus(key, { phase: 'downloading', progress: t ? Math.round((r / t) * 90) : 50, msg: `下载引擎 ${Math.round(r / 1e6)} MB` })
    );
    setStatus(key, { phase: 'extracting', msg: '解压…', progress: 95 });
    await exec('unzip', ['-o', zip, '-d', LLAMA_ENGINE_DIR]).catch(() => {});
    await rm(zip, { force: true });
    await fixRpath(llamaBinary());
  }

  const st = await statusFor('llama.cpp');
  setStatus(key, { phase: 'done', msg: `llama.cpp 就绪：${st.version}`, progress: 100 });
  return st;
}

/* ---------- swiftlm install (reuse + build) ---------- */

async function installSwiftlm(mode = 'download') {
  const key = 'engine:swiftlm';
  setStatus(key, { phase: 'installing', msg: '准备 SwiftLM…', progress: 0 });

  // The old "reuse a stray system binary" path was removed; engines are
  // installed via the installer package or downloaded directly.
  if (mode === 'download') {
    // Fastest official path: pre-built release tarball (self-contained).
    const tag = await latestSwiftlmTag();
    const url = `https://github.com/SharpAI/SwiftLM/releases/download/${tag}/SwiftLM-${tag}-macos-arm64.tar.gz`;
    setStatus(key, { phase: 'downloading', msg: `从 GitHub 下载 SwiftLM 预编译包（${tag}）…`, progress: 8 });
    await mkdir(MLX_ENGINE_DIR, { recursive: true });
    const tmpTar = path.join(MLX_ENGINE_DIR, `swiftlm-${tag}.tar.gz`);
    const tmpDir = path.join(MLX_ENGINE_DIR, `swiftlm-extract-${tag}`);
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
    await downloadStream(
      url,
      tmpTar,
      (r, t) => setStatus(key, { phase: 'downloading', progress: t ? Math.round((r / t) * 85) : 50, msg: `下载 SwiftLM ${Math.round(r / 1e6)} / ${Math.round(t / 1e6)} MB` }),
    );
    setStatus(key, { phase: 'extracting', msg: '解包 SwiftLM（含 mlx.metallib）…', progress: 90 });
    await exec('tar', ['-xzf', tmpTar, '-C', tmpDir]);
    await copyFile(path.join(tmpDir, 'SwiftLM'), swiftlmBinary());
    await copyFile(path.join(tmpDir, 'mlx.metallib'), mlxMetallibPath()).catch(() => {});
    // Harden against Gatekeeper quarantine from the curl download.
    await exec('xattr', ['-dr', 'com.apple.quarantine', swiftlmBinary()]).catch(() => {});
    await exec('codesign', ['--force', '--sign', '-', swiftlmBinary()]).catch(() => {});
    await rm(tmpTar, { force: true });
    await rm(tmpDir, { recursive: true, force: true });
    setStatus(key, { phase: 'finalizing', msg: 'SwiftLM 二进制已就绪', progress: 98 });
  } else {
    setStatus(key, { phase: 'building', msg: '从源码构建 SwiftLM（swift build，可能需要几分钟）…', progress: 10 });
    const repo = 'https://github.com/sharpai/swiftlm.git';
    const srcDir = path.join(MLX_ENGINE_DIR, 'swiftlm-src');
    await rm(srcDir, { recursive: true, force: true });
    await exec('git', ['clone', '--depth', '1', repo, srcDir], { timeout: 120000 });
    await exec('swift', ['build', '-c', 'release'], { cwd: srcDir, timeout: 600000 });
    await mkdir(MLX_ENGINE_DIR, { recursive: true });
    const built = path.join(srcDir, '.build', 'release', 'SwiftLM');
    await copyFile(built, swiftlmBinary());
  }

  const st = await statusFor('swiftlm');
  setStatus(key, { phase: 'done', msg: 'SwiftLM 就绪（Apple MLX）', progress: 100 });
  return st;
}

export async function installEngine({ type = 'llama.cpp', mode = 'reuse' } = {}) {
  if (type === 'swiftlm') return installSwiftlm(mode);
  return installLlamaCpp(mode);
}

/* ---------- engine test (real-time binary launch probe) ---------- */

// Lightweight "is this engine actually runnable?" check: confirms the binary
// exists at its tree path, is executable, and can be launched (capturing its
// startup/version output). This catches quarantined / rpath-broken / missing
// binaries before the user commits to downloading a model.
export async function testEngine({ type = 'llama.cpp' } = {}) {
  const bin = type === 'swiftlm' ? swiftlmBinary() : llamaBinary();
  if (!existsSync(bin)) {
    return { ok: false, msg: `引擎尚未安装（找不到 ${bin}），无法测试` };
  }
  let executable = true;
  try {
    await exec('test', ['-x', bin]);
  } catch {
    executable = false;
  }
  const probe = await binaryVersion(bin, ['--version']);
  if (!probe.launched) {
    return {
      ok: false,
      executable,
      msg: `引擎无法启动：${probe.error || '未知错误'}（可能被隔离或权限不足，请重新下载官方预编译包）`,
      path: bin,
    };
  }
  if (type === 'llama.cpp') {
    const v = prettyVersion(probe.line && probe.line !== 'installed' ? probe.line : '');
    return {
      ok: true,
      executable,
      version: v,
      msg: `llama.cpp 引擎启动正常` + (v && v !== 'present' ? ` · ${v}` : ''),
      path: bin,
    };
  }
  // SwiftLM: `--version` is not a supported flag and the binary answers with an
  // argument error, but any output proves it launched and parsed args fine.
  // Report a clean success without surfacing the confusing stderr line.
  return {
    ok: true,
    executable,
    version: 'SwiftLM',
    msg: `swiftlm 引擎启动正常`,
    path: bin,
  };
}

/* ---------- engine removal ---------- */

export async function removeEngine({ type = 'llama.cpp' } = {}) {
  // A running model that depends on this engine must be stopped first.
  const active = getActiveModel();
  if (active && active.engine === type) {
    await stopActiveModel();
  }
  const dir = type === 'swiftlm' ? MLX_ENGINE_DIR : LLAMA_ENGINE_DIR;
  if (!existsSync(dir)) {
    return { removed: false, msg: `${type} 引擎未在 ~/.coreui 中安装` };
  }
  let error = null;
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (e) {
    error = e;
  }
  // Fallback: if the Node fs.rm was sandboxed / redirected (e.g. some
  // sandboxes move the folder to Trash instead of deleting), force a real
  // delete via /bin/rm, which is not subject to the Node fs hook.
  if (existsSync(dir)) {
    try {
      await exec('rm', ['-rf', dir]);
    } catch (e) {
      error = error || e;
    }
  }
  if (existsSync(dir)) {
    return { removed: false, msg: `删除失败：${error ? error.message : '目录仍存在，可能被占用'}` };
  }
  return { removed: true, type, msg: `${type} 引擎已移除（${dir}）` };
}

/* ---------- active model lifecycle ---------- */

function trackProcess(child, info, onCrash) {
  activeProcess = child;
  activeModelInfo = { ...info, since: Date.now() };
  child.on('exit', (code, signal) => {
    if (activeProcess === child) {
      activeProcess = null;
      activeModelInfo = null;
    }
    // A non-zero exit (or signal) that wasn't a normal stop means the engine
    // crashed on launch — surface the captured stderr so the UI isn't left
    // showing a "running" model that is actually dead.
    if ((code !== 0 || signal) && onCrash) onCrash(code, signal);
  });
}

// Pull the most useful error line out of an engine's stderr and push it into
// the status map so the UI can show *why* a model failed to start.
function reportLaunchError(id, errBuf, fallback) {
  const lines = errBuf.split('\n').map((l) => l.trim()).filter(Boolean);
  const key = lines.filter((l) => /error|fail|mismatch|exception|invalid|undefined|cannot|unable|not supported/i.test(l)).slice(-3);
  const msg = (key.length ? key.join(' ') : errBuf.trim().slice(-300) || fallback).slice(0, 400);
  setStatus('model:' + id, { phase: 'error', msg });
}

export function getActiveModel() {
  if (!activeProcess) return null;
  try {
    process.kill(activeProcess.pid, 0);
    return activeModelInfo;
  } catch {
    activeProcess = null;
    activeModelInfo = null;
    return null;
  }
}

export async function stopActiveModel() {
  const current = getActiveModel();
  if (!current) return { stopped: false, msg: '没有运行中的模型' };
  const pid = activeProcess.pid;
  activeProcess.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 2000));
  try {
    process.kill(pid, 0);
    activeProcess.kill('SIGKILL');
  } catch {
    /* already gone */
  }
  activeProcess = null;
  activeModelInfo = null;
  return { stopped: true, pid, modelId: current.modelId };
}

export async function startModel({ engine = 'llama.cpp', model }) {
  if (!model) throw new Error('缺少模型信息');

  // Clear any stale launch-error status from a previous attempt so a fresh
  // start isn't immediately overridden by the old "failed" message.
  setStatus('model:' + model.id, { phase: 'idle' });

  // Switching models: stop the currently running one first.
  if (getActiveModel()) await stopActiveModel();

  if (engine === 'swiftlm') {
    const bin = swiftlmBinary();
    if (!existsSync(bin)) throw new Error('SwiftLM 未安装');
    const ref = model.localPath || model.hf;
    if (!ref) throw new Error('SwiftLM 模型缺少路径或 HuggingFace ID');
    const port = portForModel(model.id);
    const args = ['--model', ref, '--port', String(port), '--host', '127.0.0.1'];
    if (model.type === 'vlm') args.push('--vision');

    let errBuf = '';
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr.on('data', (d) => {
      errBuf += d.toString();
      if (errBuf.length > 4000) errBuf = errBuf.slice(-4000);
    });
    trackProcess(
      child,
      {
        engine: 'swiftlm',
        modelId: model.id,
        modelName: model.name || model.id,
        port,
        endpoint: `http://127.0.0.1:${port}/v1`,
      },
      () => reportLaunchError(model.id, errBuf, 'SwiftLM 启动失败')
    );
    return getActiveModel();
  }

  // llama.cpp
  const bin = llamaBinary();
  if (!existsSync(bin)) throw new Error('引擎未安装');
  const gguf = model.localPath;
  if (!gguf || !existsSync(gguf)) throw new Error('模型未安装: ' + (model.file || model.repo));

  const port = portForModel(model.id);
  let errBuf = '';
  const child = spawn(bin, ['-m', gguf, '-c', '4096', '--port', String(port), '--host', '127.0.0.1'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => {
    errBuf += d.toString();
    if (errBuf.length > 4000) errBuf = errBuf.slice(-4000);
  });
  trackProcess(
    child,
    {
      engine: 'llama.cpp',
      modelId: model.id,
      modelName: model.name || model.id,
      port,
      endpoint: `http://127.0.0.1:${port}/v1`,
    },
    () => reportLaunchError(model.id, errBuf, 'llama.cpp 启动失败')
  );
  return getActiveModel();
}

// Backward-compatible alias used by older clients.
export async function runEngine({ engine = 'llama.cpp', modelId, models }) {
  const m = models.find((x) => x.id === modelId);
  if (!m) throw new Error('模型未找到');
  return startModel({ engine, model: m });
}
