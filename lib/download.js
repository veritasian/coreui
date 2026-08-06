// Streaming file download with progress, integrity check, and automatic retry.
//
// Note: Node's global fetch (undici) does NOT read the system HTTP/SOCKS
// proxy, so downloads here bypass the macOS system proxy (e.g. biaogeCor:7890)
// and go straight to the host. Defaults to a DIRECT connection.
//
// Reliability: large files pulled over a flaky proxy can be truncated mid-stream
// (e.g. a 190 MB SwiftLM tarball arriving as 3 MB). To avoid a silent "done"
// on a corrupt file we (1) verify received bytes against Content-Length and
// (2) retry the whole download a few times before giving up.
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { rm } from 'node:fs/promises';

export async function downloadStream(url, dest, onProgress, proxy, opts = {}) {
  const retries = opts.retries ?? 3;

  if (proxy) {
    // Minimal HTTP CONNECT tunnel via a tiny undici dispatcher is not available
    // without the undici package; for now proxy is honored only when the caller
    // sets NODE env. Documented limitation; direct is the default path.
    process.env.HTTPS_PROXY = proxy;
    process.env.HTTP_PROXY = proxy;
  }

  let lastErr = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`下载失败: HTTP ${res.status} (${url})`);

      const total = Number(res.headers.get('content-length') || 0);
      let received = 0;

      if (res.body) {
        const file = createWriteStream(dest);
        const reader = res.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.length;
          await writeChunk(file, value);
          if (onProgress) onProgress(received, total, attempt, retries);
        }
        await new Promise((resolve) => file.end(resolve));
      } else {
        const buf = Buffer.from(await res.arrayBuffer());
        await pipeline(Readable.from(buf), createWriteStream(dest));
        received = buf.length;
        if (onProgress) onProgress(received, total, attempt, retries);
      }

      // Integrity check: if the server advertised a length, we must have it all.
      // A truncated transfer is the classic "progress hit 100% but file is broken".
      if (total > 0 && received < total) {
        throw new Error(`下载不完整：收到 ${received} / ${total} 字节（第 ${attempt} 次尝试）`);
      }
      return { received, total, attempt };
    } catch (e) {
      lastErr = e;
      // Drop the partial file so the next attempt starts clean.
      await rm(dest, { force: true }).catch(() => {});
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 600 * attempt));
        continue;
      }
    }
  }
  throw new Error(`下载失败（已重试 ${retries} 次）：${lastErr?.message || '未知错误'}`);
}

// write() can return false under backpressure; wait for drain before continuing
// so we never silently drop bytes on very large files.
function writeChunk(file, value) {
  return new Promise((resolve, reject) => {
    const ok = file.write(value);
    if (ok) return resolve();
    file.once('drain', resolve);
    file.once('error', reject);
  });
}
