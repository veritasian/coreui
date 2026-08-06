// Shared in-memory status store. The UI polls /api/status to render progress.
const store = new Map();

export function setStatus(key, val) {
  const prev = store.get(key) || {};
  store.set(key, { ...prev, ...val, ts: Date.now() });
}

export function getStatus(key) {
  return store.get(key) || null;
}

export function allStatus() {
  return Object.fromEntries(store);
}
