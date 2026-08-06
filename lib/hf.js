// HuggingFace model search + metadata helpers.
//
// Used by the "Search" tab in CoreUI. The HF API is queried directly
// (bypassing system proxy) and results are normalized so the frontend can
// filter/sort by format, parameter size, downloads, likes and recency.

const HF_API = 'https://huggingface.co/api';

function parseParamB(tags) {
  // Tags like "7b", "1.5b", "30b" appear on most quantized repos.
  for (const tag of tags || []) {
    const lower = String(tag).toLowerCase();
    const m = lower.match(/(\d+(?:\.\d+)?)b/);
    if (m) return parseFloat(m[1]);
  }
  return null;
}

function sizeBucket(paramB) {
  if (!paramB) return null;
  if (paramB <= 1) return '1';
  if (paramB <= 3) return '3';
  if (paramB <= 7) return '7';
  if (paramB <= 13) return '13';
  if (paramB <= 32) return '32';
  return '33';
}

function formatFromTags(tags) {
  const t = (tags || []).map((x) => String(x).toLowerCase());
  if (t.includes('gguf')) return 'gguf';
  if (t.includes('mlx')) return 'mlx';
  return null;
}

function formatFromRepo(id) {
  if (/\-gguf$/i.test(id)) return 'gguf';
  if (/\-mlx$/i.test(id) || /^mlx-community\//i.test(id)) return 'mlx';
  return null;
}

function typeFromTags(tags, pipeline_tag) {
  const t = (tags || []).map((x) => String(x).toLowerCase()).join(' ');
  if (/vision|vlm|multimodal|image-to-text|visual/i.test(t)) return 'vlm';
  if (/embeddings|embedding|feature-extraction/i.test(t + ' ' + (pipeline_tag || ''))) return 'embedding';
  return 'llm';
}

// Rough quantized size estimate: 4-bit quantized = 0.5 bytes/param.
function paramSizeToGB(paramB) {
  if (!paramB) return null;
  return Math.round(paramB * 0.5 * 10) / 10;
}

function normalize(m) {
  const tags = Array.isArray(m.tags) ? m.tags : [];
  const paramB = parseParamB(tags);
  const fmt = formatFromTags(tags) || formatFromRepo(m.id);
  const sizeGB = paramSizeToGB(paramB);
  return {
    id: m.id,
    repo: m.id,
    name: m.id,
    author: m.id.split('/')[0],
    description: m.description || m.cardData?.description || '',
    engine: fmt === 'mlx' ? 'swiftlm' : fmt === 'gguf' ? 'llama.cpp' : 'unknown',
    format: fmt,
    type: typeFromTags(tags, m.pipeline_tag),
    paramB,
    sizeGB,
    sizeBucket: sizeBucket(paramB),
    downloads: Number(m.downloads) || 0,
    likes: Number(m.likes) || 0,
    trending: Number(m.trendingScore) || 0,
    created: m.createdAt || null,
    modified: m.lastModified || null,
    tags: tags.slice(0, 12),
  };
}

export async function searchHF({ q = '', format = 'all', size = 'all', sort = 'downloads', limit = 50 }) {
  const params = new URLSearchParams();
  if (q) params.set('search', q);

  // HF filter supports single library/tag filters. For GGUF/MLX we can request
  // the matching filter directly; "all" means we ask for one and post-filter,
  // or do two parallel requests. Two requests are cleaner and let us sort
  // accurately without client-side merging headaches.
  const sortMap = {
    downloads: 'downloads',
    likes: 'likes',
    trending: 'trendingScore',
    newest: 'createdAt',
  };
  params.set('sort', sortMap[sort] || 'downloads');
  params.set('direction', '-1');
  params.set('limit', String(limit));
  params.set('full', 'true');

  const base = `${HF_API}/models?${params.toString()}`;
  const urls = [];
  if (format === 'all') {
    urls.push(base + '&filter=gguf');
    urls.push(base + '&filter=mlx');
  } else if (format === 'gguf') {
    urls.push(base + '&filter=gguf');
  } else if (format === 'mlx') {
    urls.push(base + '&filter=mlx');
  } else {
    urls.push(base);
  }

  const results = [];
  for (const url of urls) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HF search failed: ${res.status} (${url})`);
    const data = await res.json();
    for (const m of Array.isArray(data) ? data : []) results.push(normalize(m));
  }

  // Client-side size filter.
  return results.filter((m) => {
    if (size === 'all') return true;
    if (!m.sizeBucket) return false;
    return m.sizeBucket === size;
  });
}

// Resolve the primary GGUF file for a repo via the HF tree API.
export async function resolveGGUF(repo) {
  const url = `${HF_API}/models/${repo}/tree/main`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`无法读取模型文件清单: ${res.status}`);
  const tree = await res.json();
  const files = tree.filter((f) => f.type === 'file' && /\.gguf$/i.test(f.path));
  if (!files.length) throw new Error('该仓库未找到 .gguf 文件');

  // Prefer smaller quants for broad compatibility; otherwise the first file.
  const preferred =
    files.find((f) => /q4_k_m\.gguf$/i.test(f.path)) ||
    files.find((f) => /q4\.gguf$/i.test(f.path)) ||
    files[0];

  return {
    file: preferred.path,
    size: preferred.size || 0,
    url: `https://huggingface.co/${repo}/resolve/main/${preferred.path}`,
  };
}
