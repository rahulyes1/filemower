'use strict';

// Small helpers shared by the api/* functions. Plain Node req/res only, so the
// same handlers run on Vercel and under scripts/dev.mjs.

const ID_RE = /^[0-9a-f]{64}$/;

// One encrypted part: 3 MiB of ciphertext + 12-byte IV + 16-byte GCM tag.
const PART_BYTES = 3 * 1024 * 1024;
const MAX_PART_BODY = PART_BYTES + 28;
const MAX_PARTS = 10; // 10 × 3 MiB = 30 MiB
const MAX_META_BODY = 8 * 1024;

const TTL_MS = Number(process.env.FILEMOVER_TTL_MS) || 30 * 60 * 1000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function query(req) {
  return new URL(req.url, 'http://x').searchParams;
}

function requireId(req) {
  const id = query(req).get('id') || '';
  if (!ID_RE.test(id)) throw new HttpError(400, 'bad id');
  return id;
}

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const payload = isBuf ? body : JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', isBuf ? 'application/octet-stream' : 'application/json; charset=utf-8');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(payload);
}

// Read the raw request body, refusing anything over `limit` bytes.
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (declared > limit) return reject(new HttpError(413, 'too large'));
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Wrap a handler so thrown HttpErrors become JSON replies.
function handler(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) send(res, status, { error: err.message || 'server error' });
    }
  };
}

module.exports = {
  HttpError,
  handler,
  query,
  requireId,
  send,
  readBody,
  PART_BYTES,
  MAX_PART_BODY,
  MAX_PARTS,
  MAX_META_BODY,
  TTL_MS,
};
