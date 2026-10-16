'use strict';

// PUT /api/part?id=&n=   store encrypted part n
// GET /api/part?id=&n=   read encrypted part n of a live (unexpired) file

const { getStore, getLiveMeta } = require('../lib/store');
const { handler, query, requireId, send, readBody, HttpError, MAX_PART_BODY, MAX_PARTS } = require('../lib/http');

function partIndex(req) {
  const raw = query(req).get('n');
  const n = Number(raw);
  if (!/^\d+$/.test(raw || '') || n >= MAX_PARTS) throw new HttpError(400, 'bad part');
  return n;
}

module.exports = handler(async (req, res) => {
  const id = requireId(req);
  const n = partIndex(req);
  const store = getStore();

  if (req.method === 'PUT') {
    const body = await readBody(req, MAX_PART_BODY);
    if (body.length < 28) throw new HttpError(400, 'part too small');
    await store.putPart(id, n, body);
    return send(res, 200, { ok: true });
  }

  if (req.method === 'GET') {
    const meta = await getLiveMeta(store, id);
    if (!meta || n >= meta.parts) throw new HttpError(404, 'not found');
    const buf = await store.getPart(id, n);
    if (!buf) throw new HttpError(404, 'not found');
    return send(res, 200, buf);
  }

  throw new HttpError(405, 'method not allowed');
});
