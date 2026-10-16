'use strict';

/*
 * Encrypted-blob storage.
 *
 *   f/<id>/meta.json   { parts, created, encMeta }   written last
 *   f/<id>/<n>         encrypted part n
 *
 * Production: Vercel Blob with private access (no public URLs; readable only
 * through our functions). Local dev: a folder under the OS temp dir.
 * On Vercel without a connected Blob store every call fails with a clear 503.
 */

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { HttpError, TTL_MS } = require('./http');

const metaPath = (id) => `f/${id}/meta.json`;
const partPath = (id, n) => `f/${id}/${n}`;

// ---------- Vercel Blob ----------

function blobStore() {
  const blob = require('@vercel/blob');
  const access = process.env.BLOB_ACCESS || 'private';
  const putOpts = {
    access,
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/octet-stream',
    cacheControlMaxAge: 60,
  };

  async function read(pathname) {
    const r = await blob.get(pathname, { access, useCache: false }).catch((err) => {
      if (err && /not.?found/i.test(err.name + err.message)) return null;
      throw err;
    });
    if (!r || r.statusCode !== 200 || !r.stream) return null;
    return Buffer.from(await new Response(r.stream).arrayBuffer());
  }

  return {
    async putPart(id, n, buf) {
      await blob.put(partPath(id, n), buf, putOpts);
    },
    async getPart(id, n) {
      return read(partPath(id, n));
    },
    async putMeta(id, meta) {
      await blob.put(metaPath(id), JSON.stringify(meta), { ...putOpts, contentType: 'application/json' });
    },
    async getMeta(id) {
      const buf = await read(metaPath(id));
      return buf ? JSON.parse(buf.toString('utf8')) : null;
    },
    async remove(id, parts) {
      const paths = [metaPath(id)];
      for (let n = 0; n < parts; n++) paths.push(partPath(id, n));
      await blob.del(paths);
    },
    async sweep(cutoff) {
      let cursor;
      let deleted = 0;
      do {
        const page = await blob.list({ prefix: 'f/', cursor, limit: 1000 });
        const old = page.blobs.filter((b) => new Date(b.uploadedAt).getTime() < cutoff);
        if (old.length) {
          await blob.del(old.map((b) => b.url));
          deleted += old.length;
        }
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      return deleted;
    },
  };
}

// ---------- local folder (dev only) ----------

function diskStore() {
  const root = path.join(os.tmpdir(), 'filemover-dev');
  const file = (p) => path.join(root, ...p.split('/'));

  async function write(p, data) {
    await fs.mkdir(path.dirname(file(p)), { recursive: true });
    await fs.writeFile(file(p), data);
  }
  async function read(p) {
    try {
      return await fs.readFile(file(p));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  return {
    putPart: (id, n, buf) => write(partPath(id, n), buf),
    getPart: (id, n) => read(partPath(id, n)),
    putMeta: (id, meta) => write(metaPath(id), JSON.stringify(meta)),
    async getMeta(id) {
      const buf = await read(metaPath(id));
      return buf ? JSON.parse(buf.toString('utf8')) : null;
    },
    async remove(id) {
      await fs.rm(path.join(root, 'f', id), { recursive: true, force: true });
    },
    async sweep(cutoff) {
      let deleted = 0;
      const dir = path.join(root, 'f');
      const ids = await fs.readdir(dir).catch(() => []);
      for (const id of ids) {
        const stat = await fs.stat(path.join(dir, id)).catch(() => null);
        if (stat && stat.mtimeMs < cutoff) {
          await fs.rm(path.join(dir, id), { recursive: true, force: true });
          deleted++;
        }
      }
      return deleted;
    },
  };
}

// ---------- selection ----------

function isConfigured() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
}

let cached;
function getStore() {
  if (cached) return cached;
  if (isConfigured()) cached = blobStore();
  else if (process.env.VERCEL) {
    throw new HttpError(503, 'Storage is not connected yet. Add a Blob store to this Vercel project.');
  } else cached = diskStore();
  return cached;
}

// Meta for a file that still exists and hasn't expired, else null.
// Expired files are deleted on the spot, so nothing is readable after the TTL.
async function getLiveMeta(store, id) {
  const meta = await store.getMeta(id);
  if (!meta) return null;
  if (Date.now() - meta.created > TTL_MS) {
    await store.remove(id, meta.parts);
    return null;
  }
  return meta;
}

module.exports = { getStore, isConfigured, getLiveMeta };
