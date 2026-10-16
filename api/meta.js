'use strict';

// PUT    /api/meta?id=   finish an upload: { parts, encMeta } (sent after every part)
// GET    /api/meta?id=   { parts, encMeta, expiresIn } for a live file, else 404
// DELETE /api/meta?id=   delete the file now (burn after download / "delete now")

const { getStore, getLiveMeta } = require('../lib/store');
const { handler, requireId, send, readBody, HttpError, MAX_META_BODY, MAX_PARTS, TTL_MS } = require('../lib/http');

module.exports = handler(async (req, res) => {
  const id = requireId(req);
  const store = getStore();

  if (req.method === 'PUT') {
    let body;
    try {
      body = JSON.parse((await readBody(req, MAX_META_BODY)).toString('utf8'));
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, 'bad json');
    }
    const { parts, encMeta } = body || {};
    if (!Number.isInteger(parts) || parts < 1 || parts > MAX_PARTS) throw new HttpError(400, 'bad parts');
    if (typeof encMeta !== 'string' || !/^[A-Za-z0-9+/=]{1,4096}$/.test(encMeta)) {
      throw new HttpError(400, 'bad meta');
    }
    const created = Date.now();
    await store.putMeta(id, { parts, encMeta, created });
    return send(res, 200, { ok: true, expiresIn: TTL_MS });
  }

  if (req.method === 'GET') {
    const meta = await getLiveMeta(store, id);
    if (!meta) throw new HttpError(404, 'No file for this key. It may be wrong, already downloaded, or expired.');
    const expiresIn = meta.created + TTL_MS - Date.now();
    return send(res, 200, { parts: meta.parts, encMeta: meta.encMeta, expiresIn });
  }

  if (req.method === 'DELETE') {
    const meta = await store.getMeta(id);
    if (meta) await store.remove(id, meta.parts);
    return send(res, 200, { ok: true });
  }

  throw new HttpError(405, 'method not allowed');
});
