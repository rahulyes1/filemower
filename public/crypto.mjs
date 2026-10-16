/*
 * File Mover crypto. Runs in browsers and in Node (tests import this file).
 *
 * key (12 digits) --PBKDF2-SHA256, 600k--> 512 bits
 *   bits[0..32)  -> lookup id (hex). The only thing the server ever sees.
 *   bits[32..64) -> AES-256-GCM key. Never leaves the device.
 *
 * Because the id comes from the slow KDF, someone holding the stored data
 * can't cheaply brute-force the key from it.
 *
 * Part n of N on the wire: [iv:12][ciphertext+tag], AAD = "n/N"
 * (stops parts being reordered, swapped between files, or dropped).
 * File name/type/size are encrypted separately (AAD = "meta").
 */

export const KEY_DIGITS = 12;
// 1 MiB parts keep every request short even on a slow mobile uplink.
export const PART_BYTES = 1024 * 1024;
export const MAX_PARTS = 30;
export const MAX_FILE_BYTES = MAX_PARTS * PART_BYTES; // 30 MiB

const SALT = new TextEncoder().encode('filemover/v2');
const ITERATIONS = 600000;
const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = globalThis.crypto.subtle;

export function newKey() {
  // Uniform digits via rejection sampling (bytes >= 250 would bias % 10).
  let out = '';
  while (out.length < KEY_DIGITS) {
    for (const b of globalThis.crypto.getRandomValues(new Uint8Array(16))) {
      if (b < 250 && out.length < KEY_DIGITS) out += b % 10;
    }
  }
  return out;
}

export const cleanKey = (s) => String(s || '').replace(/\D/g, '').slice(0, KEY_DIGITS);
export const formatKey = (digits) => cleanKey(digits).replace(/(\d{4})(?=\d)/g, '$1-');
export const partCount = (size) => Math.max(1, Math.ceil(size / PART_BYTES));

export async function deriveKeys(digits) {
  if (cleanKey(digits).length !== KEY_DIGITS) throw new Error('Key must be 12 digits');
  const base = await subtle.importKey('raw', enc.encode(cleanKey(digits)), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(
    await subtle.deriveBits({ name: 'PBKDF2', salt: SALT, iterations: ITERATIONS, hash: 'SHA-256' }, base, 512)
  );
  const id = [...bits.subarray(0, 32)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const key = await subtle.importKey('raw', bits.subarray(32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { id, key };
}

async function seal(key, plain, aad) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, plain)
  );
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out;
}

async function open(key, data, aad) {
  return new Uint8Array(
    await subtle.decrypt(
      { name: 'AES-GCM', iv: data.subarray(0, 12), additionalData: enc.encode(aad) },
      key,
      data.subarray(12)
    )
  );
}

export const encryptPart = (key, plain, n, total) => seal(key, plain, `${n}/${total}`);
export const decryptPart = (key, data, n, total) => open(key, data, `${n}/${total}`);

export async function encryptMeta(key, meta) {
  const sealed = await seal(key, enc.encode(JSON.stringify(meta)), 'meta');
  let s = '';
  for (const b of sealed) s += String.fromCharCode(b);
  return btoa(s);
}

export async function decryptMeta(key, b64) {
  const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return JSON.parse(dec.decode(await open(key, data, 'meta')));
}
