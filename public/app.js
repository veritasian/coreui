// CoreUI frontend — Apple-minimal provisioning wizard. Vanilla JS, no build step.
const $ = (sel) => document.querySelector(sel);

let currentStep = 0;
let currentModelTab = 'best';
let detectResult = null;
let engines = {};
let catalogModels = [];
let installedModels = [];
let searchResults = [];
let activeModel = null;
let audioService = null;

const statusRows = new Map(); // id -> { el, stateEl, btn, meta }

/* ---------- step navigation (sidebar) ---------- */
const STEP_TITLES = [
  ['检测系统', '点一下，看看你的电脑能跑哪类模型。'],
  ['安装引擎', '引擎我们做了安装包，双击装好即可。装完点「检测」确认。'],
  ['安装模型', '模型你自己下载，粘进文件夹就行。点「已安装」查看。'],
  ['使用说明', '看不懂？这一页一步一步教你怎么用。'],
];

function goStep(n) {
  currentStep = n;
  document.querySelectorAll('.nav-item').forEach((b) => {
    b.classList.toggle('is-active', Number(b.dataset.step) === n);
  });
  document.querySelectorAll('.panel').forEach((p) => {
    p.classList.toggle('is-active', Number(p.dataset.panel) === n);
  });
  $('#pageTitle').textContent = STEP_TITLES[n][0];
  $('#pageLead').textContent = STEP_TITLES[n][1];
}
document.querySelectorAll('.nav-item').forEach((b) => {
  b.addEventListener('click', () => goStep(Number(b.dataset.step)));
});

/* ---------- model tabs + type filter ---------- */
let currentTypeFilter = 'all'; // 'all' | 'llm' | 'vlm'

// VLM 类型也包含 vlm-projector（视觉投影器）。TTS/STT 为音频模型。
function matchesType(m) {
  if (currentTypeFilter === 'all') return true;
  if (currentTypeFilter === 'vlm') return m.type === 'vlm' || m.type === 'vlm-projector';
  if (currentTypeFilter === 'tts') return m.type === 'tts';
  if (currentTypeFilter === 'stt') return m.type === 'stt';
  return m.type === 'llm';
}

function isAudio(m) {
  return m.type === 'tts' || m.type === 'stt';
}

// 同一个模型永远用同一个端口（8200–8799），不同模型端口不同。
// 这样「切换模型」不会冲突，也能靠端口区分模型。
function portForModel(id) {
  let h = 2166136261 >>> 0;
  const s = String(id);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return 8200 + (h % 600);
}

// 统一的模型按钮：开启 / 关闭 / 切换 / 移除（语音模型为 部署 / 关闭 / 移除）。
// 单一活动模型：已在跑→关闭；别的在跑→切换；都没跑→开启。
function modelActions(m) {
  const actions = [];
  if (isAudio(m)) {
    const running = audioService && audioService.modelId === m.id;
    if (running) actions.push(actionBtn('关闭', 'primary', () => stopAudioService()));
    else actions.push(actionBtn('部署', 'primary', () => deployAudioModel(m.id)));
    actions.push(actionBtn('移除', '', () => removeModel(m.id)));
    return actions;
  }
  const running = activeModel && activeModel.modelId === m.id;
  const otherRunning = activeModel && !running;
  if (running) actions.push(actionBtn('关闭', 'primary', () => stopModel()));
  else if (otherRunning) actions.push(actionBtn('切换', 'primary', () => startModelById(m.id)));
  else actions.push(actionBtn('开启', 'primary', () => startModelById(m.id)));
  actions.push(actionBtn('移除', '', () => removeModel(m.id)));
  return actions;
}

function switchModelTab(tab) {
  currentModelTab = tab;
  document.querySelectorAll('#modelTabs .tab').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.tab === tab);
  });
  document.querySelectorAll('[data-tab-panel]').forEach((p) => {
    p.classList.toggle('is-active', p.dataset.tabPanel === tab);
  });
  // Show search-only filters (search box / format / size / sort) only on Search tab.
  $('#modelSection').classList.toggle('search-mode', tab === 'search');
  if (tab === 'installed') loadInstalled();
  else if (tab === 'best') renderBestMatch();
  else if (tab === 'search') renderSearch();
}
document.querySelectorAll('#modelTabs .tab').forEach((b) => {
  b.addEventListener('click', () => switchModelTab(b.dataset.tab));
});

document.querySelectorAll('#typeFilter button').forEach((b) => {
  b.addEventListener('click', () => {
    currentTypeFilter = b.dataset.type;
    document.querySelectorAll('#typeFilter button').forEach((x) =>
      x.classList.toggle('is-active', x === b),
    );
    if (currentModelTab === 'best') renderBestMatch();
    else if (currentModelTab === 'search') renderSearch();
    else loadInstalled();
  });
});

/* ---------- step 1: detect ---------- */
async function runDetect() {
  const btn = $('#detectBtn');
  btn.disabled = true;
  btn.textContent = '检测中…';
  try {
    detectResult = await (await fetch('/api/detect')).json();
    renderDetect(detectResult);
  } catch (e) {
    $('#detectGrid').innerHTML = `<div class="cell wide"><div class="v">检测失败：${e.message}</div></div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '重新检测';
    document.querySelector('.nav-item[data-step="1"]').disabled = false;
  }
}

function renderDetect(d) {
  const rec = d.recommended || {};
  const cells = [
    ['操作系统', `${d.platform} ${d.osVersion || ''}`.trim()],
    ['架构', d.arch],
    ['计算设备', `${d.gpu} · ${d.gpuApi.toUpperCase()}`],
    ['内存', `${d.ramGB} GB`],
    ['可用磁盘', `${d.diskFreeGB} GB`],
    ['模型目录', d.modelRoot, true],
  ];
  let html = cells
    .map(
      ([k, v, wide]) =>
        `<div class="cell ${wide ? 'wide' : ''}"><div class="k">${k}</div><div class="v">${v}</div></div>`
    )
    .join('');
  html += `<div class="cell wide"><div class="k">推荐配置</div><div class="v">${rec.engine || '—'}<small>${rec.model || ''} · ${rec.note || ''}</small></div></div>`;
  $('#detectGrid').innerHTML = html;
}

$('#detectBtn').addEventListener('click', runDetect);

/* ---------- step 2: engines (multi-engine) ---------- */
async function loadEngines() {
  engines = await (await fetch('/api/engine')).json();
  renderEngines(engines);
}

function engineStatusText(s) {
  if (!s) return '未满足前置条件';
  if (s.installed) return '已安装' + (s.version ? ' · ' + s.version : '');
  return s.note || '未满足前置条件';
}

function engineCardHTML(id, label, desc, s) {
  const st = s || {};
  const canTest = !!st.installed;
  return `
  <div class="engine-card" data-engine="${id}">
    <div class="ec-head">
      <div class="ec-title">${label}</div>
      <div class="ec-desc">${desc}</div>
    </div>
    <div class="ec-actions">
      <button class="btn primary" data-act="download">下载预编译包</button>
      <button class="btn ghost" data-act="test" ${canTest ? '' : 'disabled'} title="运行引擎二进制，确认可启动">测试</button>
      <button class="btn danger" data-act="remove" ${canTest ? '' : 'disabled'} title="删除该引擎及其文件">删除</button>
    </div>
    <div class="status ${st.installed ? 'done' : ''}" data-role="status">${engineStatusText(st)}</div>
    <div class="progress"><div class="bar" data-role="bar"></div></div>
    <div class="test-result" data-role="test"></div>
  </div>`;
}

function renderEngines(e) {
  const wrap = $('#engines');
  const cards = [
    engineCardHTML('llama.cpp', 'llama.cpp', '跨平台 GGUF 推理运行时（CPU / Metal / CUDA）。', e.llamaCpp),
    engineCardHTML(
      'swiftlm',
      'SwiftLM (Apple MLX)',
      'Apple Silicon 专属的 MLX 原生推理服务，OpenAI 兼容。',
      e.swiftlm
    ),
  ];
  wrap.innerHTML = cards.join('');

  wrap.querySelectorAll('.engine-card').forEach((card) => {
    const id = card.dataset.engine;
    card.querySelectorAll('button[data-act]').forEach((btn) => {
      if (btn.dataset.act === 'test') {
        btn.addEventListener('click', () => testEngine(id));
      } else if (btn.dataset.act === 'remove') {
        btn.addEventListener('click', () => removeEngine(id));
      } else {
        btn.addEventListener('click', () => installEngine(id, btn.dataset.act));
      }
    });
  });
}

// Lightweight periodic sync of engine installed/available state, driven by
// /api/engine. Skips any engine whose install is currently in progress (so it
// never clobbers the live progress message rendered by renderEngineStatus).
async function syncEngineInstalled(st) {
  try {
    const e = await (await fetch('/api/engine')).json();
    const busy = new Set();
    if (st) {
      for (const key of ['engine:llama.cpp', 'engine:swiftlm']) {
        const ph = st[key]?.phase;
        if (ph && ph !== 'done' && ph !== 'error') busy.add(key.slice('engine:'.length));
      }
    }
    for (const key of ['llama.cpp', 'swiftlm']) {
      if (busy.has(key)) continue;
      const s = e[key];
      const card = document.querySelector(`.engine-card[data-engine="${key}"]`);
      if (!card || !s) continue;
      const box = card.querySelector('[data-role="status"]');
      const tbtn = card.querySelector('button[data-act="test"]');
      const dbtn = card.querySelector('button[data-act="remove"]');
      box.textContent = engineStatusText(s);
      box.className = 'status' + (s.installed ? ' done' : '');
      if (tbtn) tbtn.disabled = !s.installed;
      if (dbtn) dbtn.disabled = !s.installed;
    }
  } catch {
    /* ignore transient errors */
  }
}

async function installEngine(type, mode) {
  await fetch('/api/engine/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, mode }),
  });
}

async function testEngine(type) {
  const card = document.querySelector(`.engine-card[data-engine="${type}"]`);
  const box = card?.querySelector('[data-role="test"]');
  if (!box) return;
  box.className = 'test-result';
  box.textContent = '测试中…';
  try {
    const r = await (
      await fetch('/api/engine/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type }),
      })
    ).json();
    if (r.ok) {
      box.className = 'test-result ok';
      box.textContent = '✓ ' + r.msg;
    } else {
      box.className = 'test-result err';
      box.textContent = '✗ ' + r.msg;
    }
  } catch (e) {
    box.className = 'test-result err';
    box.textContent = '✗ 测试请求失败：' + e.message;
  }
}

async function removeEngine(type) {
  const where = type === 'swiftlm' ? 'mlx' : 'llama';
  if (!confirm(`确定删除 ${type} 引擎？其文件（~/.coreui/engine/${where}/）将被移除。`)) return;
  const card = document.querySelector(`.engine-card[data-engine="${type}"]`);
  const box = card ? card.querySelector('[data-role="status"]') : null;
  if (box) {
    box.className = 'status';
    box.textContent = '删除中…';
  }
  try {
    const res = await fetch('/api/engine/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type }),
    });
    const r = await res.json();
    if (r.removed) {
      if (box) {
        box.className = 'status done';
        box.textContent = '已删除';
      }
    } else if (r.msg) {
      if (box) {
        box.className = 'status error';
        box.textContent = r.msg;
      }
    }
    loadEngines();
    loadInstalled();
    if (typeof refreshActiveBanner === 'function') refreshActiveBanner();
  } catch (e) {
    if (box) {
      box.className = 'status error';
      box.textContent = '删除失败：' + e.message;
    }
    loadEngines();
    loadInstalled();
  }
}

function renderEngineStatus(key, s) {
  const card = document.querySelector(`.engine-card[data-engine="${key}"]`);
  if (!card || !s) return;
  const box = card.querySelector('[data-role="status"]');
  const bar = card.querySelector('[data-role="bar"]');
  box.textContent = s.msg || s.phase || s.note || '';
  box.className = 'status' + (s.phase === 'done' ? ' done' : s.phase === 'error' ? ' error' : '');
  bar.style.width = (s.progress != null ? s.progress : s.phase === 'downloading' ? 50 : 0) + '%';
  if (s.phase === 'done') {
    const tbtn = card.querySelector('button[data-act="test"]');
    if (tbtn) tbtn.disabled = false;
  }
}

/* ---------- model cards ---------- */
function formatBadge(fmt) {
  if (fmt === 'gguf') return '<span class="tag fmt-gguf">GGUF</span>';
  if (fmt === 'mlx') return '<span class="tag fmt-mlx">MLX</span>';
  return '<span class="tag">' + (fmt || '?') + '</span>';
}

function typeBadge(type) {
  if (type === 'vlm' || type === 'vlm-projector') return '<span class="tag vlm">VLM</span>';
  if (type === 'tts') return '<span class="tag tts">TTS</span>';
  if (type === 'stt') return '<span class="tag stt">STT</span>';
  if (type === 'embedding') return '<span class="tag">Embedding</span>';
  return '<span class="tag">LLM</span>';
}

function serveBadge(m) {
  if (m.serve === 'orpheus') return '<span class="tag fmt-gguf">Orpheus</span>';
  if (m.serve === 'kokoro') return '<span class="tag fmt-mlx">Kokoro</span>';
  if (m.serve === 'whisper') return '<span class="tag">Whisper</span>';
  return '';
}

function sizeBadge(paramB, sizeGB) {
  if (paramB) return `<span class="tag size">${paramB}B</span>`;
  if (sizeGB) return `<span class="tag size">${sizeGB} GB</span>`;
  return '';
}

function statBadges(m) {
  const parts = [];
  if (m.downloads != null) parts.push(`<span class="stat">↓ ${formatCount(m.downloads)}</span>`);
  if (m.likes != null) parts.push(`<span class="stat">♥ ${formatCount(m.likes)}</span>`);
  if (m.trending != null && m.trending > 0) parts.push(`<span class="stat">🔥 ${m.trending.toFixed(1)}</span>`);
  return parts.join(' ');
}

function formatCount(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

function modelCardHTML(m, actionsHTML, extraClass = '', port = null) {
  const isRunning = activeModel && activeModel.modelId === m.id;
  const portChip = port ? `<span class="tag port">端口 ${port}</span>` : '';
  return `
    <div class="model ${extraClass} ${isRunning ? 'running' : ''}" data-id="${m.id}">
      <div class="info">
        <div class="name">
          ${escapeHtml(m.name)}
          ${formatBadge(m.format || (m.engine === 'swiftlm' ? 'mlx' : 'gguf'))}
          ${serveBadge(m)}
          ${typeBadge(m.type)}
          ${sizeBadge(m.paramB, m.sizeGB)}
        </div>
        <div class="desc">${escapeHtml(m.description || '')}</div>
        <div class="meta">
          ${statBadges(m)}
          ${portChip}
          ${m.localSizeMB ? `<span class="stat">本地 ${m.localSizeMB} MB</span>` : ''}
        </div>
      </div>
      <div class="actions">${actionsHTML}</div>
      <div class="state"></div>
    </div>`;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function actionBtn(label, cls, onClick, disabled = false, title = '') {
  return `<button class="btn ${cls}" ${disabled ? 'disabled' : ''} ${title ? `title="${title}"` : ''}>${label}</button>`;
}

/* ---------- best match ---------- */
async function loadModels() {
  catalogModels = await (await fetch('/api/models')).json();
  renderBestMatch();
}

function renderBestMatch() {
  const wrap = $('#bestMatchList');
  wrap.innerHTML = '';
  statusRows.clear();

  const recEngine = detectResult?.recommended?.engine?.toLowerCase().includes('swiftlm') ? 'swiftlm' : 'llama.cpp';

  // Apply type filter, then show recommended first, then by size.
  const sorted = [...catalogModels].filter(matchesType).sort((a, b) => {
    const ar = (a.recommended && a.engine === recEngine) ? 2 : a.recommended ? 1 : 0;
    const br = (b.recommended && b.engine === recEngine) ? 2 : b.recommended ? 1 : 0;
    if (ar !== br) return br - ar;
    return a.sizeGB - b.sizeGB;
  });

  for (const m of sorted) {
    const isRec = m.recommended && m.engine === recEngine;
    const actions = m.installed
      ? modelActions(m)
      : [actionBtn('安装', 'primary', () => installCatalogModel(m.id))];
    const port = m.installed ? portForModel(m.id) : null;
    const html = modelCardHTML(m, actions.join(''), isRec ? 'recommended' : '', port);
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    const row = tmp.firstElementChild;
    attachActions(row, m);
    if (isRec) {
      const badge = document.createElement('div');
      badge.className = 'rec-badge';
      badge.textContent = 'Best Match';
      row.querySelector('.info').appendChild(badge);
    }
    wrap.appendChild(row);
    statusRows.set(m.id, { el: row, stateEl: row.querySelector('.state'), btn: row.querySelector('.btn'), meta: m });
  }
}

function attachActions(row, m) {
  row.querySelectorAll('button').forEach((btn) => {
    const text = btn.textContent.trim();
    if (text === '安装') btn.onclick = () => installCatalogModel(m.id);
    if (text === '开启') btn.onclick = () => startModelById(m.id);
    if (text === '切换') btn.onclick = () => startModelById(m.id);
    if (text === '关闭') btn.onclick = () => stopModel();
    if (text === '部署') btn.onclick = () => deployAudioModel(m.id);
    if (text === '移除') btn.onclick = () => removeModel(m.id);
  });
}

async function installCatalogModel(id) {
  const r = statusRows.get(id);
  if (r) {
    r.btn.disabled = true;
    r.btn.textContent = '下载中';
    r.stateEl.textContent = '排队中…';
  }
  await fetch('/api/model/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
}

async function removeModel(id) {
  if (!confirm('确定删除该模型？文件将从电脑中移除。')) return;
  await fetch('/api/model/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  loadModels();
  loadInstalled();
}

/* ---------- search ---------- */
async function doHFSearch() {
  const q = $('#hfSearch').value.trim();
  const format = $('#hfFormat').value;
  const size = $('#hfSize').value;
  const sort = $('#hfSort').value;
  const wrap = $('#searchList');
  wrap.innerHTML = '<div class="empty">搜索中…</div>';
  try {
    const params = new URLSearchParams({ q, format, size, sort });
    searchResults = await (await fetch('/api/hf/search?' + params.toString())).json();
    if (searchResults.error) throw new Error(searchResults.error);
    renderSearch();
  } catch (e) {
    wrap.innerHTML = `<div class="empty error">搜索失败：${e.message}</div>`;
  }
}

function renderSearch() {
  const wrap = $('#searchList');
  wrap.innerHTML = '';
  const list = searchResults.filter(matchesType);
  if (!searchResults.length) {
    wrap.innerHTML = '<div class="empty">无结果，换个关键词或筛选条件试试</div>';
    return;
  }
  if (!list.length) {
    wrap.innerHTML = '<div class="empty">当前类型筛选下无结果</div>';
    return;
  }
  for (const m of list) {
    const inst = installedModels.find((x) => x.repo === m.repo);
    let html;
    if (inst) {
      const actions = modelActions(inst);
      html = modelCardHTML(inst, actions.join(''), '', portForModel(inst.id));
    } else if (m.format === 'gguf' || m.format === 'mlx') {
      const actions = [actionBtn('安装', 'primary', () => installHFModel(m))];
      html = modelCardHTML(m, actions.join(''));
    } else {
      html = modelCardHTML({ ...m, installed: false }, [actionBtn('未知格式', '', null, true)]);
    }
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    const row = tmp.firstElementChild;
    row.querySelectorAll('button').forEach((btn) => {
      const text = btn.textContent.trim();
      if (text === '安装') btn.onclick = () => installHFModel(m);
      if (text === '开启') btn.onclick = () => startModelById(inst.id);
      if (text === '切换') btn.onclick = () => startModelById(inst.id);
      if (text === '关闭') btn.onclick = () => stopModel();
      if (text === '部署') btn.onclick = () => deployAudioModel(inst.id);
      if (text === '移除') btn.onclick = () => removeModel(inst.id);
    });
    wrap.appendChild(row);
    statusRows.set(m.id, { el: row, stateEl: row.querySelector('.state'), btn: row.querySelector('.btn'), meta: m });
  }
}

async function installHFModel(m) {
  const r = statusRows.get(m.id);
  if (r) {
    r.btn.disabled = true;
    r.btn.textContent = '下载中';
    r.stateEl.textContent = '排队中…';
  }
  await fetch('/api/hf/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo: m.repo, engine: m.engine, type: m.type }),
  });
}

$('#hfSearchBtn').addEventListener('click', doHFSearch);
$('#hfSearch').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doHFSearch();
});
$('#hfFormat').addEventListener('change', doHFSearch);
$('#hfSize').addEventListener('change', doHFSearch);
$('#hfSort').addEventListener('change', doHFSearch);

/* ---------- installed ---------- */
async function loadInstalled() {
  installedModels = await (await fetch('/api/model/installed')).json();
  renderInstalled();
}

function renderInstalled() {
  const wrap = $('#installedList');
  wrap.innerHTML = '';
  const list = installedModels.filter(matchesType);
  if (!installedModels.length) {
    wrap.innerHTML = '<div class="empty">暂无已安装模型。去「推荐」或「搜索」安装一个。</div>';
    return;
  }
  if (!list.length) {
    wrap.innerHTML = '<div class="empty">当前类型筛选下没有已安装模型</div>';
    return;
  }
  for (const m of list) {
    const running = isAudio(m)
      ? audioService && audioService.modelId === m.id
      : activeModel && activeModel.modelId === m.id;
    const actions = modelActions(m);
    const html = modelCardHTML(m, actions.join(''), running ? 'running' : '', portForModel(m.id));
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    const row = tmp.firstElementChild;
    wrap.appendChild(row);
    statusRows.set(m.id, { el: row, stateEl: row.querySelector('.state'), btn: row.querySelector('.btn'), meta: m });
  }
}

/* ---------- start / stop ---------- */
async function startModelById(id) {
  const prev = activeModel ? activeModel.modelName || activeModel.modelId : null;
  const box = $('#endpoint');
  box.className = 'endpoint';
  try {
    const r = await (
      await fetch('/api/model/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
    ).json();
    if (r.error) {
      showEndpoint('错误：' + r.error, true);
      return;
    }
    activeModel = r;
    const name = r.modelName || r.modelId;
    const switched = prev && prev !== name;
    const head = switched ? `已关闭「${prev}」，开启「${name}」` : `已开启「${name}」`;
    showEndpoint(`${head}<br>${r.engine} 接口（端口 ${r.port}）：${r.endpoint}<br>PID：${r.pid}`);
    refreshActiveBanner();
    renderInstalled();
    renderBestMatch();
  } catch (e) {
    showEndpoint('启动失败：' + e.message, true);
  }
}

async function stopModel() {
  const r = await (await fetch('/api/model/stop', { method: 'POST' })).json();
  if (r.stopped) {
    activeModel = null;
    showEndpoint('模型已关闭');
    refreshActiveBanner();
    renderInstalled();
    renderBestMatch();
  }
}

$('#stopModelBtn').addEventListener('click', stopModel);
$('#switchModelBtn').addEventListener('click', () => {
  switchModelTab('installed');
});

/* ---------- audio (TTS / STT) deploy ---------- */
async function deployAudioModel(id) {
  const box = $('#endpoint');
  box.className = 'endpoint';
  try {
    const r = await (
      await fetch('/api/audio/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
    ).json();
    if (r.error) {
      showEndpoint('错误：' + r.error, true);
      return;
    }
    showEndpoint('正在部署音频服务… 首次会创建 Python 虚拟环境并安装依赖（需联网，可能耗时数分钟）。就绪后下方横幅会显示接口地址。', false);
  } catch (e) {
    showEndpoint('部署请求失败：' + e.message, true);
  }
}

async function stopAudioService() {
  const r = await (await fetch('/api/audio/stop', { method: 'POST' })).json();
  if (r.stopped) {
    audioService = null;
    refreshAudioBanner();
    renderInstalled();
  }
}

$('#stopAudioBtn').addEventListener('click', stopAudioService);

function refreshAudioBanner() {
  const banner = $('#audioService');
  if (!audioService) {
    banner.style.display = 'none';
    return;
  }
  banner.style.display = 'flex';
  $('#audioServiceDetail').innerHTML = `
    <strong>${escapeHtml(audioService.modelName || audioService.modelId)}</strong>
    <span>${audioService.serve?.toUpperCase()} · OpenAI 兼容：${audioService.endpoint}</span>
  `;
}

function showEndpoint(html, isError = false) {
  const box = $('#endpoint');
  box.className = 'endpoint show' + (isError ? ' error' : '');
  box.innerHTML = html;
}

function refreshActiveBanner() {
  const banner = $('#activeModel');
  if (!activeModel) {
    banner.style.display = 'none';
    return;
  }
  banner.style.display = 'flex';
  $('#activeModelDetail').innerHTML = `
    <strong>${escapeHtml(activeModel.modelName || activeModel.modelId)}</strong>
    <span>${activeModel.engine} · 端口 ${activeModel.port} · ${activeModel.endpoint}</span>
  `;
}

/* ---------- polling ---------- */
async function poll() {
  let st = null;
  try {
    st = await (await fetch('/api/status')).json();
    for (const [key, val] of Object.entries(st)) {
      if (key.startsWith('engine:')) {
        renderEngineStatus(key.slice('engine:'.length), val);
      } else if (key.startsWith('model:')) {
        const id = key.slice('model:'.length);
        const r = statusRows.get(id);
        if (r) {
          updateModelStatus(id, val);
        }
      }
    }
  } catch {
    /* ignore transient errors */
  }

  // Keep engine installed/available badges in sync (e.g. after an offline
  // pkg install or a manual copy) without clobbering in-progress installs.
  await syncEngineInstalled(st);

  // Poll active model separately.
  try {
    const { active } = await (await fetch('/api/model/active')).json();
    const had = !!activeModel;
    activeModel = active;
    refreshActiveBanner();
    if ((had && !active) || (!had && active)) {
      renderInstalled();
      renderBestMatch();
    }
  } catch {
    /* ignore */
  }

  // Poll audio service separately.
  try {
    const { service } = await (await fetch('/api/audio/status')).json();
    const hadAudio = !!audioService;
    audioService = service;
    refreshAudioBanner();
    if ((hadAudio && !service) || (!hadAudio && service)) {
      renderInstalled();
      renderBestMatch();
    }
  } catch {
    /* ignore */
  }
}

function updateModelStatus(id, val) {
  const r = statusRows.get(id);
  if (!r) return;
  if (val.phase === 'done') {
    r.stateEl.textContent = '安装完成';
    r.btn.textContent = '开启';
    r.btn.disabled = false;
    r.btn.className = 'btn primary';
    r.btn.onclick = () => startModelById(id);
    loadModels();
    loadInstalled();
  } else if (val.phase === 'error') {
    r.stateEl.textContent = val.msg || '失败';
    r.btn.textContent = '重试';
    r.btn.disabled = false;
    r.btn.className = 'btn primary';
    r.btn.onclick = () => {
      const m = r.meta;
      if (m && m.installed) startModelById(id);
      else if (m && m.repo && !m.file) installHFModel(m);
      else installCatalogModel(id);
    };
  } else if (val.phase === 'idle') {
    // Fresh start cleared a previous error; leave the card in its natural state.
  } else if (val.phase === 'downloading') {
    r.stateEl.textContent = val.msg || '下载中…';
    r.btn.textContent = '下载中';
    r.btn.disabled = true;
  } else {
    r.stateEl.textContent = val.msg || val.phase || '';
  }
}

// ---------- documentation page (inline, non-modal) ----------
// 面向第一次使用者的简短使用说明（傻瓜式、直奔主题）。
function buildDocHTML() {
  const map = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
  const curName = map[detectResult?.platform] || '你的电脑';
  return `
  <div class="doc-head">
    <h2>使用说明（一步一步来）</h2>
    <p class="doc-lead">看不懂术语也没关系。照下面四步走，就能在本地跑起 AI 模型。不联网也能用。</p>
  </div>

  <div class="callout">💡 所有东西都跑在你自己的电脑上，模型和对话内容不会上传到任何服务器。</div>

  <h3>第 1 步：检测系统</h3>
  <p>点左边「检测系统」→「开始检测」。它看一眼你的电脑（系统、芯片、内存），告诉你适合跑什么。这一步不用联网。</p>
  <p class="doc-sub">系统配置明细表：你的电脑该装什么引擎、跑什么模型？</p>
  <table class="ig-table">
    <thead><tr><th>你的电脑</th><th>建议引擎</th><th>建议模型（参数量）</th><th>量化位宽</th></tr></thead>
    <tbody>
      <tr><td>8GB 内存</td><td>llama.cpp</td><td>3B 以下（如 Qwen3-0.8B、Llama-3.2-1B）</td><td>4-bit</td></tr>
      <tr><td>16GB 内存（Apple Silicon）</td><td>SwiftLM 或 llama.cpp</td><td>7B–13B（如 Qwen3-7B、Llama-3.1-8B）</td><td>4-bit</td></tr>
      <tr><td>16GB 内存（Intel / AMD）</td><td>llama.cpp</td><td>7B 左右</td><td>4-bit</td></tr>
      <tr><td>32GB 内存（Apple Silicon）</td><td>SwiftLM 或 llama.cpp</td><td>13B–30B</td><td>4-bit</td></tr>
      <tr><td>64GB 及以上</td><td>两个都行</td><td>30B 以上</td><td>4-bit；要更聪明就 8-bit（内存翻倍）</td></tr>
    </tbody>
  </table>
  <p class="doc-note">记住两条：① 参数越大越聪明，也越吃内存，先看内存再选模型；② 量化 4-bit 最省内存，8-bit 质量更好但占用翻倍，拿不准就选 4-bit。</p>

  <h3>第 2 步：装引擎</h3>
  <p>引擎就是“让模型跑起来的程序”。<strong>我们已经做好了安装包</strong>：</p>
  <ul class="doc-list">
    <li>双击我们给你的引擎安装包，按提示装好即可。</li>
    <li>装好后回到本页「安装引擎」，点引擎卡片上的<strong>「检测」</strong>按钮。显示“正常”就说明装好了。</li>
  </ul>
  <p class="doc-note">两个引擎二选一：llama.cpp（通用）或 SwiftLM（苹果芯片专用，更快）。</p>

  <h3>第 3 步：装模型</h3>
  <p>模型需要你自己下载（从官网 / HuggingFace，或用别人给的包）：</p>
  <ul class="doc-list">
    <li>把下载好的模型文件夹或 .gguf 文件，直接粘到对应目录（见下表）。CoreUI 会自动识别。</li>
    <li>粘好后，去「安装模型」→「已安装」就能看到它。</li>
  </ul>
  <table class="ig-table">
    <thead><tr><th>模型类型</th><th>粘到这个文件夹</th></tr></thead>
    <tbody>
      <tr><td>GGUF 模型（llama.cpp）</td><td><code>~/.coreui/models/llama/</code></td></tr>
      <tr><td>MLX 模型（SwiftLM）</td><td><code>~/.coreui/models/mlx/</code></td></tr>
      <tr><td>语音模型（TTS / STT）</td><td><code>~/.coreui/models/audio/</code></td></tr>
    </tbody>
  </table>

  <h3>第 4 步：用模型</h3>
  <ul class="doc-list">
    <li>到「安装模型」→「已安装」，找到你的模型。</li>
    <li>点<strong>「开启」</strong>：模型开始运行，页面会给你一个本地地址（像 <code>http://127.0.0.1:8234/v1</code>），别的程序就能连它了。</li>
    <li>不用了点<strong>「关闭」</strong>：停下模型，释放电脑资源。</li>
    <li>想换一个模型：直接点另一个模型的<strong>「切换」</strong>，会自动关掉当前的、开新的。</li>
  </ul>
  <p class="doc-note">每个模型都有自己固定的端口（8200–8799 之间），不会互相打架。卡片上能看到端口号。</p>

  <h3>常见问题</h3>
  <ul class="doc-list">
    <li><b>检测显示没装好？</b> 先确认引擎安装包已双击装好；再点「检测」看一次。</li>
    <li><b>模型在「已安装」里看不到？</b> 检查文件是否粘对了文件夹（看第 3 步表格）。</li>
    <li><b>开启后没反应？</b> 多半是模型文件损坏或路径不对；重新下载再粘一次。</li>
    <li><b>想删掉？</b> 引擎卡片点「删除」；模型点「删除」即可，文件会从电脑移除。</li>
  </ul>
  `;
}

function renderDoc() {
  const el = document.getElementById('docBody');
  if (el) el.innerHTML = buildDocHTML();
}

/* ---------- init ---------- */
(async function init() {
  document.querySelector('.nav-item[data-step="1"]').disabled = true;
  document.querySelector('.nav-item[data-step="2"]').disabled = true;
  await runDetect();
  document.querySelector('.nav-item[data-step="1"]').disabled = false;
  document.querySelector('.nav-item[data-step="2"]').disabled = false;
  await loadEngines();
  await loadModels();
  await loadInstalled();
  renderDoc();
  setInterval(poll, 700);
})();
