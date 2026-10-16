'use strict';

// GET /api/health — lets the UI tell "storage not connected" apart from other errors.

const { isConfigured } = require('../lib/store');
const { handler, send } = require('../lib/http');

module.exports = handler(async (req, res) => {
  const storage = isConfigured() ? 'blob' : process.env.VERCEL ? 'missing' : 'local';
  send(res, 200, { ok: storage !== 'missing', storage });
});
