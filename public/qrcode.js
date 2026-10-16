'use strict';

/*
 * Minimal, self-contained QR Code generator (byte mode, EC level M,
 * versions 1-6). Enough to encode a short LAN URL. No dependencies.
 *
 * Algorithm follows the ISO/IEC 18004 standard; structure adapted from the
 * well-known public-domain reference by Nayuki. Renders to a <canvas>.
 */
const QR = (function () {
  // ---- GF(256) arithmetic ----
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

  function rsGenerator(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= mul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }
  function rsRemainder(data, degree) {
    const gen = rsGenerator(degree);
    const buf = data.concat(new Array(degree).fill(0));
    for (let i = 0; i < data.length; i++) {
      const factor = buf[i];
      if (factor !== 0) for (let j = 0; j < gen.length; j++) buf[i + j] ^= mul(gen[j], factor);
    }
    return buf.slice(data.length);
  }

  // version -> { size, align centers, blocks, data codewords/block, ec/block, remainder bits }
  const VER = {
    1: { size: 21, align: [], blocks: 1, dc: 16, ec: 10, rem: 0 },
    2: { size: 25, align: [6, 18], blocks: 1, dc: 28, ec: 16, rem: 7 },
    3: { size: 29, align: [6, 22], blocks: 1, dc: 44, ec: 26, rem: 7 },
    4: { size: 33, align: [6, 26], blocks: 2, dc: 32, ec: 18, rem: 7 },
    5: { size: 37, align: [6, 30], blocks: 2, dc: 43, ec: 24, rem: 7 },
    6: { size: 41, align: [6, 34], blocks: 4, dc: 27, ec: 16, rem: 7 },
  };

  const getBit = (v, i) => ((v >>> i) & 1) !== 0;

  function chooseVersion(len) {
    for (let v = 1; v <= 6; v++) {
      const cap = VER[v].dc * VER[v].blocks; // data codewords
      // header = 4 (mode) + 8 (byte count) bits = 12 bits; total bits = 12 + 8*len
      if (Math.ceil((12 + 8 * len) / 8) <= cap) return v;
    }
    throw new Error('data too long for QR (v1-6)');
  }

  function buildCodewords(bytes, V) {
    const capacity = V.dc * V.blocks;
    // bit buffer
    const bits = [];
    const push = (val, n) => {
      for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1);
    };
    push(0b0100, 4); // byte mode
    push(bytes.length, 8); // count (v1-9)
    for (const b of bytes) push(b, 8);
    // terminator
    const capBits = capacity * 8;
    for (let i = 0; i < 4 && bits.length < capBits; i++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);
    // pad bytes
    const pads = [0xec, 0x11];
    let p = 0;
    while (bits.length < capBits) push(pads[p++ % 2], 8);
    // to bytes
    const data = [];
    for (let i = 0; i < bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      data.push(b);
    }
    // split into blocks, compute EC
    const dataBlocks = [];
    const ecBlocks = [];
    for (let b = 0; b < V.blocks; b++) {
      const block = data.slice(b * V.dc, (b + 1) * V.dc);
      dataBlocks.push(block);
      ecBlocks.push(rsRemainder(block, V.ec));
    }
    // interleave
    const out = [];
    for (let i = 0; i < V.dc; i++) for (const bl of dataBlocks) out.push(bl[i]);
    for (let i = 0; i < V.ec; i++) for (const bl of ecBlocks) out.push(bl[i]);
    // to bit array (MSB first) + remainder bits
    const outBits = [];
    for (const b of out) for (let i = 7; i >= 0; i--) outBits.push((b >> i) & 1);
    for (let i = 0; i < V.rem; i++) outBits.push(0);
    return outBits;
  }

  function makeMatrix(text) {
    const bytes = Array.from(new TextEncoder().encode(text));
    const v = chooseVersion(bytes.length);
    const V = VER[v];
    const size = V.size;
    const grid = Array.from({ length: size }, () => new Array(size).fill(false));
    const func = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (x, y, dark) => {
      grid[y][x] = dark;
      func[y][x] = true;
    };

    // finder + separators (9x9 by Chebyshev distance)
    const finder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++)
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx, y = cy + dy;
          if (x < 0 || y < 0 || x >= size || y >= size) continue;
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          set(x, y, d !== 2 && d !== 4);
        }
    };
    finder(3, 3);
    finder(size - 4, 3);
    finder(3, size - 4);

    // timing
    for (let i = 0; i < size; i++) {
      if (!func[6][i]) set(i, 6, i % 2 === 0);
      if (!func[i][6]) set(6, i, i % 2 === 0);
    }

    // alignment patterns
    const pos = V.align;
    const last = pos.length - 1;
    for (let i = 0; i < pos.length; i++)
      for (let j = 0; j < pos.length; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
        const cx = pos[i], cy = pos[j];
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++)
            set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }

    // dark module
    set(8, size - 8, true);

    // reserve format-info area (marked as function so data skips it)
    for (let i = 0; i <= 8; i++) {
      if (!func[i][8]) func[i][8] = true;
      if (!func[8][i]) func[8][i] = true;
    }
    for (let i = 0; i < 8; i++) {
      func[8][size - 1 - i] = true;
      func[size - 1 - i][8] = true;
    }

    // place data
    const dataBits = buildCodewords(bytes, V);
    let idx = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      const col = right === 6 ? 5 : right;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = col - j;
          const upward = ((col + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!func[y][x]) {
            grid[y][x] = idx < dataBits.length ? dataBits[idx] === 1 : false;
            idx++;
          }
        }
      }
    }

    // pick best mask
    let best = null, bestPenalty = Infinity;
    for (let m = 0; m < 8; m++) {
      const g = grid.map((r) => r.slice());
      applyMask(g, func, m, size);
      drawFormat(g, m, size);
      const pen = penalty(g, size);
      if (pen < bestPenalty) { bestPenalty = pen; best = g; }
    }
    return best;
  }

  function maskCond(m, x, y) {
    switch (m) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    }
  }
  function applyMask(g, func, m, size) {
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++)
        if (!func[y][x] && maskCond(m, x, y)) g[y][x] = !g[y][x];
  }

  function drawFormat(g, mask, size) {
    const data = (0 << 3) | mask; // EC level M = 0
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const s = (x, y, b) => (g[y][x] = b);
    for (let i = 0; i <= 5; i++) s(8, i, getBit(bits, i));
    s(8, 7, getBit(bits, 6));
    s(8, 8, getBit(bits, 7));
    s(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) s(14 - i, 8, getBit(bits, i));
    for (let i = 0; i < 8; i++) s(size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i++) s(8, size - 15 + i, getBit(bits, i));
    g[size - 8][8] = true; // dark module
  }

  // penalty scoring (ISO rules 1-4) to select the least-noisy mask
  function penalty(g, size) {
    let p = 0;
    // rule 1: runs of 5+ same color, per row and column
    for (let y = 0; y < size; y++) {
      let runC = g[y][0], run = 1;
      for (let x = 1; x < size; x++) {
        if (g[y][x] === runC) { run++; } else { if (run >= 5) p += run - 2; runC = g[y][x]; run = 1; }
      }
      if (run >= 5) p += run - 2;
    }
    for (let x = 0; x < size; x++) {
      let runC = g[0][x], run = 1;
      for (let y = 1; y < size; y++) {
        if (g[y][x] === runC) { run++; } else { if (run >= 5) p += run - 2; runC = g[y][x]; run = 1; }
      }
      if (run >= 5) p += run - 2;
    }
    // rule 2: 2x2 blocks
    for (let y = 0; y < size - 1; y++)
      for (let x = 0; x < size - 1; x++) {
        const c = g[y][x];
        if (c === g[y][x + 1] && c === g[y + 1][x] && c === g[y + 1][x + 1]) p += 3;
      }
    // rule 3: finder-like 1:1:3:1:1 patterns
    const pat1 = [true, false, true, true, true, false, true, false, false, false, false];
    const pat2 = [false, false, false, false, true, false, true, true, true, false, true];
    const match = (arr, i, pat) => pat.every((v, k) => arr[i + k] === v);
    for (let y = 0; y < size; y++)
      for (let x = 0; x <= size - 11; x++) {
        if (match(g[y], x, pat1) || match(g[y], x, pat2)) p += 40;
      }
    for (let x = 0; x < size; x++) {
      const col = [];
      for (let y = 0; y < size; y++) col.push(g[y][x]);
      for (let y = 0; y <= size - 11; y++)
        if (match(col, y, pat1) || match(col, y, pat2)) p += 40;
    }
    // rule 4: dark/light balance
    let dark = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (g[y][x]) dark++;
    const ratio = (dark * 100) / (size * size);
    p += Math.floor(Math.abs(ratio - 50) / 5) * 10;
    return p;
  }

  function render(canvas, text) {
    const modules = makeMatrix(text);
    const n = modules.length;
    const quiet = 4;
    const total = n + quiet * 2;
    const px = canvas.width || 180;
    const scale = Math.max(1, Math.floor(px / total));
    const dim = scale * total;
    canvas.width = dim;
    canvas.height = dim;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, dim, dim);
    ctx.fillStyle = '#000';
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++)
        if (modules[y][x])
          ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
  }

  return { render, makeMatrix };
})();
