'use strict';

// GET /api/cleanup — daily cron (vercel.json). Reads already refuse anything
// past the 30-minute TTL; this physically purges leftovers nobody downloaded.

const { getStore } = require('../lib/store');
const { handler, send, HttpError, TTL_MS } = require('../lib/http');

const GRACE_MS = 10 * 60 * 1000; // parts are written slightly before their meta

module.exports = handler(async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) throw new HttpError(401, 'unauthorized');
  const deleted = await getStore().sweep(Date.now() - TTL_MS - GRACE_MS);
  send(res, 200, { ok: true, deleted });
});
