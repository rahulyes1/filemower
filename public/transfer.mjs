/*
 * Upload/download engine. Used by the web app and by test/e2e.mjs, so the
 * tests exercise exactly what the site runs. `base` is '' in the browser and
 * an absolute origin in tests.
 */
import {
  MAX_FILE_BYTES,
  PART_BYTES,
  newKey,
  deriveKeys,
  partCount,
  encryptPart,
  decryptPart,
  encryptMeta,
  decryptMeta,
} from './crypto.mjs';

const CONCURRENCY = 3;

export class TransferError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// fetch with retries for network blips and 5xx (common on mobile data).
async function request(url, opts = {}, tries = 3) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url, opts);
    } catch (err) {
      if (attempt >= tries) throw new TransferError('Network error. Check your connection and try again.');
      await new Promise((r) => setTimeout(r, 500 * attempt));
      continue;
    }
    if (res.ok) return res;
    if (res.status >= 500 && res.status !== 503 && attempt < tries) {
      await new Promise((r) => setTimeout(r, 500 * attempt));
      continue;
    }
    const body = await res.json().catch(() => ({}));
    throw new TransferError(body.error || `Request failed (${res.status})`, res.status);
  }
}

async function pool(count, worker) {
  let next = 0;
  const run = async () => {
    while (next < count) await worker(next++);
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, count) }, run));
}

/** Encrypt and upload. Returns { key, id, expiresIn }. */
export async function sendFile({ base = '', bytes, name, type, onProgress = () => {} }) {
  if (bytes.length > MAX_FILE_BYTES) throw new TransferError('File is larger than 30 MB.');
  const key = newKey();
  onProgress({ stage: 'key', done: 0, total: 1 });
  const { id, key: aes } = await deriveKeys(key);
  const total = partCount(bytes.length);
  let done = 0;
  onProgress({ stage: 'upload', done, total });

  await pool(total, async (n) => {
    const plain = bytes.subarray(n * PART_BYTES, Math.min(bytes.length, (n + 1) * PART_BYTES));
    const body = await encryptPart(aes, plain, n, total);
    await request(`${base}/api/part?id=${id}&n=${n}`, { method: 'PUT', body });
    onProgress({ stage: 'upload', done: ++done, total });
  });

  const encMeta = await encryptMeta(aes, {
    name: String(name || 'file').slice(0, 200),
    type: String(type || '').slice(0, 100),
    size: bytes.length,
  });
  const res = await request(`${base}/api/meta?id=${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parts: total, encMeta }),
  });
  const { expiresIn } = await res.json();
  return { key, id, expiresIn };
}

/** Download and decrypt. Returns { id, name, type, bytes, expiresIn }. */
export async function receiveFile({ base = '', key, onProgress = () => {} }) {
  onProgress({ stage: 'key', done: 0, total: 1 });
  const { id, key: aes } = await deriveKeys(key);

  let meta;
  try {
    meta = await (await request(`${base}/api/meta?id=${id}`)).json();
  } catch (err) {
    if (err.status === 404) {
      throw new TransferError('No file for this key. It may be mistyped, already downloaded, or expired.', 404);
    }
    throw err;
  }

  let info;
  try {
    info = await decryptMeta(aes, meta.encMeta);
  } catch {
    throw new TransferError('This file could not be decrypted. It may have been tampered with.');
  }

  const total = meta.parts;
  if (partCount(info.size) !== total) throw new TransferError('File is incomplete or corrupted.');
  const bytes = new Uint8Array(info.size);
  let done = 0;
  onProgress({ stage: 'download', done, total });

  await pool(total, async (n) => {
    const res = await request(`${base}/api/part?id=${id}&n=${n}`);
    const data = new Uint8Array(await res.arrayBuffer());
    let plain;
    try {
      plain = await decryptPart(aes, data, n, total);
    } catch {
      throw new TransferError('This file could not be decrypted. It may have been tampered with.');
    }
    const expected = Math.min(PART_BYTES, info.size - n * PART_BYTES);
    if (plain.length !== expected) throw new TransferError('File is incomplete or corrupted.');
    bytes.set(plain, n * PART_BYTES);
    onProgress({ stage: 'download', done: ++done, total });
  });

  return { id, name: info.name, type: info.type, bytes, expiresIn: meta.expiresIn };
}

/** Delete a file from the server now. */
export async function deleteFile({ base = '', id }) {
  await request(`${base}/api/meta?id=${id}`, { method: 'DELETE' });
}
