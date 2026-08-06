// CoreUI server — zero-dependency Node (ESM) backend.
// Serves the Apple-minimal SPA from /public and exposes a small REST API
// that orchestrates the provisioning core: detect -> engine -> model -> run.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

import { detectSystem } from './lib/detect.js';
import { getEngineStatus, installEngine, startModel, stopActiveModel, getActiveModel, runEngine, testEngine, removeEngine } from './lib/engine.js';
import { listModels, installModel, modelsDir, listInstalledModels, installHFModel, removeModel } from './lib/model.js';
import { allStatus } from './lib/status.js';
import { searchHF } from './lib/hf.js';
import { deployAudio, stopAudio, getAudioService } from './lib/audio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

async function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  rel = rel.replace(/\.\.+\//g, ''); // prevent path traversal
  const filePath = path.join(PUBLIC, rel);
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) throw new Error('dir');
    const buf = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(buf);
  } catch {
    // SPA fallback
    try {
      const buf = await readFile(path.join(PUBLIC, 'index.html'));
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end(buf);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  }
}

async function resolveModel(id) {
  const catalog = await listModels();
  const cat = catalog.find((x) => x.id === id);
  if (cat) return cat;
  const installed = await listInstalledModels();
  return installed.find((x) => x.id === id);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    if (p === '/api/detect' && req.method === 'GET') {
      return sendJson(res, 200, await detectSystem());
    }

    if (p === '/api/engine' && req.method === 'GET') {
      return sendJson(res, 200, await getEngineStatus());
    }

    if (p === '/api/engine/install' && req.method === 'POST') {
      const { type, mode } = await readBody(req);
      installEngine({ type, mode }).catch((e) =>
        console.error('engine install failed:', e.message)
      );
      return sendJson(res, 202, { started: true });
    }

    if (p === '/api/engine/test' && req.method === 'POST') {
      const { type } = await readBody(req);
      try {
        const r = await testEngine({ type });
        return sendJson(res, 200, r);
      } catch (e) {
        return sendJson(res, 500, { ok: false, msg: e.message });
      }
    }

    if (p === '/api/engine/remove' && req.method === 'POST') {
      const { type } = await readBody(req);
      try {
        const r = await removeEngine({ type });
        return sendJson(res, 200, r);
      } catch (e) {
        return sendJson(res, 500, { ok: false, msg: e.message });
      }
    }

    if (p === '/api/models' && req.method === 'GET') {
      return sendJson(res, 200, await listModels());
    }

    if (p === '/api/model/install' && req.method === 'POST') {
      const { id, proxy } = await readBody(req);
      installModel(id, proxy).catch((e) => console.error('model install failed:', e.message));
      return sendJson(res, 202, { started: true });
    }

    if (p === '/api/hf/search' && req.method === 'GET') {
      const q = url.searchParams.get('q') || '';
      const format = url.searchParams.get('format') || 'all';
      const size = url.searchParams.get('size') || 'all';
      const sort = url.searchParams.get('sort') || 'downloads';
      try {
        const results = await searchHF({ q, format, size, sort });
        return sendJson(res, 200, results);
      } catch (e) {
        return sendJson(res, 502, { error: e.message });
      }
    }

    if (p === '/api/hf/install' && req.method === 'POST') {
      const { repo, engine, type, proxy } = await readBody(req);
      installHFModel({ repo, engine, type, proxy }).catch((e) => console.error('hf install failed:', e.message));
      return sendJson(res, 202, { started: true });
    }

    if (p === '/api/model/installed' && req.method === 'GET') {
      return sendJson(res, 200, await listInstalledModels());
    }

    if (p === '/api/model/remove' && req.method === 'POST') {
      const { id } = await readBody(req);
      try {
        const r = await removeModel(id);
        return sendJson(res, 200, r);
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (p === '/api/model/start' && req.method === 'POST') {
      const { id, engine } = await readBody(req);
      const model = await resolveModel(id);
      if (!model) return sendJson(res, 400, { error: '未知模型' });
      const targetEngine = engine || model.engine || 'llama.cpp';
      if (model.engine && model.engine !== targetEngine) {
        return sendJson(res, 400, { error: `该模型属于 ${model.engine}，与所选引擎 ${targetEngine} 不匹配` });
      }
      try {
        const active = await startModel({ engine: targetEngine, model });
        return sendJson(res, 200, active);
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (p === '/api/model/stop' && req.method === 'POST') {
      return sendJson(res, 200, await stopActiveModel());
    }

    if (p === '/api/model/active' && req.method === 'GET') {
      return sendJson(res, 200, { active: getActiveModel() });
    }

    if (p === '/api/status' && req.method === 'GET') {
      return sendJson(res, 200, allStatus());
    }

    /* ---------- audio (TTS / STT) ---------- */

    if (p === '/api/audio/deploy' && req.method === 'POST') {
      const { id } = await readBody(req);
      deployAudio({ id }).catch((e) => console.error('audio deploy failed:', e.message));
      return sendJson(res, 202, { started: true });
    }

    if (p === '/api/audio/stop' && req.method === 'POST') {
      return sendJson(res, 200, await stopAudio());
    }

    if (p === '/api/audio/status' && req.method === 'GET') {
      return sendJson(res, 200, { service: getAudioService() });
    }

    // Backward-compatible run endpoint.
    if (p === '/api/run' && req.method === 'POST') {
      const { engine, modelId } = await readBody(req);
      const models = await listModels();
      const m = models.find((x) => x.id === modelId);
      if (!m) return sendJson(res, 400, { error: '未知模型' });
      if (m.engine !== (engine || 'llama.cpp'))
        return sendJson(res, 400, { error: `该模型属于 ${m.engine}，与所选引擎不匹配` });
      if (engine === 'llama.cpp' && !m.installed)
        return sendJson(res, 400, { error: '该 LLM 未安装，请先在「安装模型」步骤下载' });
      try {
        const r = await runEngine({ engine: engine || 'llama.cpp', modelId, models });
        return sendJson(res, 200, { endpoint: r.endpoint, pid: r.pid, engine: r.engine });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (p.startsWith('/api/')) {
      return sendJson(res, 404, { error: 'unknown endpoint' });
    }

    return serveStatic(req, res, p);
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
});

const PORT = process.env.PORT || 5173;
server.listen(PORT, () => {
  console.log(`CoreUI running at http://localhost:${PORT}`);
});
