// End-to-end tests against a running deployment, using the same transfer code
// the website uses.
//
//   node test/e2e.mjs [baseUrl]                 (default http://localhost:3000)
//   node test/e2e.mjs [baseUrl] --expiry 3000   (server started with FILEMOVER_TTL_MS=3000)
import { sendFile, receiveFile, deleteFile } from '../public/transfer.mjs';
import { MAX_FILE_BYTES, PART_BYTES, newKey } from '../public/crypto.mjs';

const args = process.argv.slice(2);
const expiryIdx = args.indexOf('--expiry');
const expiryMs = expiryIdx >= 0 ? Number(args[expiryIdx + 1]) : 0;
const base = (args.find((a) => /^https?:/.test(a)) || 'http://localhost:3000').replace(/\/$/, '');

let failed = 0;
async function check(name, fn) {
  const t = Date.now();
  try {
    await fn();
    console.log(`PASS  ${name}  (${Date.now() - t} ms)`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}\n      ${err.stack || err}`);
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
function randomBytes(n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  return out;
}
const same = (a, b) => a.length === b.length && Buffer.from(a).equals(Buffer.from(b));
async function expectStatus(promise, status) {
  try {
    await promise;
  } catch (err) {
    assert(err.status === status, `expected ${status}, got ${err.status}: ${err.message}`);
    return err;
  }
  throw new Error(`expected ${status}, but it succeeded`);
}

console.log(`Testing ${base}\n`);

if (expiryMs) {
  await check(`file is gone after TTL (${expiryMs} ms)`, async () => {
    const sent = await sendFile({ base, bytes: randomBytes(1000), name: 'x.bin' });
    await receiveFile({ base, key: sent.key }); // readable before expiry
    await new Promise((r) => setTimeout(r, expiryMs + 1500));
    await expectStatus(receiveFile({ base, key: sent.key }), 404);
  });
  process.exit(failed ? 1 : 0);
}

await check('health reports storage connected', async () => {
  const h = await (await fetch(`${base}/api/health`)).json();
  assert(h.ok, `storage not ready: ${JSON.stringify(h)}`);
});

await check('30 MB round-trip is byte-identical (10 parts)', async () => {
  const bytes = randomBytes(MAX_FILE_BYTES);
  const sent = await sendFile({ base, bytes, name: 'big video.mp4', type: 'video/mp4' });
  assert(/^\d{12}$/.test(sent.key), 'key should be 12 digits');
  assert(sent.expiresIn > 29 * 60 * 1000, `expiresIn ${sent.expiresIn}`);
  const got = await receiveFile({ base, key: sent.key });
  assert(got.name === 'big video.mp4' && got.type === 'video/mp4', 'meta mismatch');
  assert(same(got.bytes, bytes), 'bytes differ');
});

await check('1-byte and empty files round-trip', async () => {
  for (const bytes of [new Uint8Array([42]), new Uint8Array(0)]) {
    const sent = await sendFile({ base, bytes, name: 'tiny.txt', type: 'text/plain' });
    const got = await receiveFile({ base, key: sent.key });
    assert(same(got.bytes, bytes), `size ${bytes.length} differs`);
  }
});

await check('wrong key finds nothing (404)', async () => {
  await sendFile({ base, bytes: randomBytes(100), name: 'a' });
  await expectStatus(receiveFile({ base, key: newKey() }), 404);
});

await check('reordered parts are rejected (AAD binds part index)', async () => {
  const sent = await sendFile({ base, bytes: randomBytes(PART_BYTES + 1000), name: 'two-parts' });
  const part1 = new Uint8Array(await (await fetch(`${base}/api/part?id=${sent.id}&n=1`)).arrayBuffer());
  await fetch(`${base}/api/part?id=${sent.id}&n=0`, { method: 'PUT', body: part1 });
  const err = await receiveFile({ base, key: sent.key }).then(() => null, (e) => e);
  assert(err && /tampered/.test(err.message), `expected tamper error, got ${err && err.message}`);
});

await check('flipped ciphertext bit is rejected', async () => {
  const sent = await sendFile({ base, bytes: randomBytes(5000), name: 'b' });
  const part = new Uint8Array(await (await fetch(`${base}/api/part?id=${sent.id}&n=0`)).arrayBuffer());
  part[100] ^= 1;
  await fetch(`${base}/api/part?id=${sent.id}&n=0`, { method: 'PUT', body: part });
  const err = await receiveFile({ base, key: sent.key }).then(() => null, (e) => e);
  assert(err && /tampered/.test(err.message), `expected tamper error, got ${err && err.message}`);
});

await check('file over 30 MB is refused before upload', async () => {
  const err = await sendFile({ base, bytes: new Uint8Array(MAX_FILE_BYTES + 1) }).then(() => null, (e) => e);
  assert(err && /30 MB/.test(err.message), `got ${err && err.message}`);
});

await check('server refuses oversized part (413) and bad ids/parts (400)', async () => {
  const id = 'a'.repeat(64);
  const big = await fetch(`${base}/api/part?id=${id}&n=0`, { method: 'PUT', body: new Uint8Array(PART_BYTES + 29) });
  assert(big.status === 413, `oversize part: ${big.status}`);
  const badId = await fetch(`${base}/api/meta?id=../../etc`);
  assert(badId.status === 400, `bad id: ${badId.status}`);
  const badN = await fetch(`${base}/api/part?id=${id}&n=10`, { method: 'PUT', body: new Uint8Array(64) });
  assert(badN.status === 400, `bad part index: ${badN.status}`);
});

await check('deleted file is gone (burn after download)', async () => {
  const sent = await sendFile({ base, bytes: randomBytes(2000), name: 'c' });
  const got = await receiveFile({ base, key: sent.key });
  await deleteFile({ base, id: got.id });
  await expectStatus(receiveFile({ base, key: sent.key }), 404);
});

console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
