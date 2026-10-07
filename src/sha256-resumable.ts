// mu — SHA-256 whose running state can be saved and resumed.
//
// Why not node:crypto: a `Hash` cannot be serialised, and every mu
// invocation is a fresh process. The segment manifest carries the
// sha256 of the WHOLE append-only segment, so re-hashing with
// node:crypto made each flush O(file size) forever. Persisting the
// running state next to the digest lets the next flush hash only the
// bytes it appends. The digest is byte-identical to node:crypto's (see
// test/sha256-resumable.test.ts), so peers verifying with node:crypto
// see no difference.

/** Serialisable running state: eight hash words (hex), bytes hashed so
 *  far, and the partial trailing block not yet compressed (base64). */
export interface Sha256State {
  h: string;
  n: number;
  tail: string;
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const INITIAL_H = "6a09e667bb67ae853c6ef372a54ff53a510e527f9b05688c1f83d9ab5be0cd19";

/** State of a hash that has consumed no bytes. */
export function sha256Initial(): Sha256State {
  return { h: INITIAL_H, n: 0, tail: "" };
}

function wordsOf(hex: string): Uint32Array {
  const h = new Uint32Array(8);
  for (let i = 0; i < 8; i++) h[i] = Number.parseInt(hex.slice(i * 8, i * 8 + 8), 16);
  return h;
}

function hexOf(h: Uint32Array): string {
  let out = "";
  for (const word of h) out += word.toString(16).padStart(8, "0");
  return out;
}

const W = new Uint32Array(64);

/** Compress every whole 64-byte block of `data` from `offset` into `h`. */
function compress(h: Uint32Array, data: Uint8Array, offset: number, end: number): void {
  let h0 = h[0] ?? 0;
  let h1 = h[1] ?? 0;
  let h2 = h[2] ?? 0;
  let h3 = h[3] ?? 0;
  let h4 = h[4] ?? 0;
  let h5 = h[5] ?? 0;
  let h6 = h[6] ?? 0;
  let h7 = h[7] ?? 0;
  for (let p = offset; p + 64 <= end; p += 64) {
    for (let i = 0; i < 16; i++) {
      const j = p + i * 4;
      W[i] =
        ((data[j] ?? 0) << 24) |
        ((data[j + 1] ?? 0) << 16) |
        ((data[j + 2] ?? 0) << 8) |
        (data[j + 3] ?? 0);
    }
    for (let i = 16; i < 64; i++) {
      const w15 = W[i - 15] ?? 0;
      const w2 = W[i - 2] ?? 0;
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      W[i] = ((W[i - 16] ?? 0) + s0 + (W[i - 7] ?? 0) + s1) | 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let hh = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + (K[i] ?? 0) + (W[i] ?? 0)) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + hh) | 0;
  }
  h.set([h0, h1, h2, h3, h4, h5, h6, h7]);
}

/** Feed `data` into `state`, returning the new state. Pure. */
export function sha256Update(state: Sha256State, data: Uint8Array): Sha256State {
  const pending = Buffer.from(state.tail, "base64");
  const all = pending.length === 0 ? data : Buffer.concat([pending, data]);
  const h = wordsOf(state.h);
  const whole = all.length - (all.length % 64);
  compress(h, all, 0, whole);
  return {
    h: hexOf(h),
    n: state.n + data.length,
    tail: Buffer.from(all.subarray(whole)).toString("base64"),
  };
}

/** Hex digest of everything fed into `state`. Does not mutate it. */
export function sha256Digest(state: Sha256State): string {
  const pending = Buffer.from(state.tail, "base64");
  const padLen = pending.length < 56 ? 64 : 128;
  const block = Buffer.alloc(padLen);
  pending.copy(block);
  block[pending.length] = 0x80;
  const bits = state.n * 8;
  block.writeUInt32BE(Math.floor(bits / 2 ** 32), padLen - 8);
  block.writeUInt32BE(bits >>> 0, padLen - 4);
  const h = wordsOf(state.h);
  compress(h, block, 0, padLen);
  return hexOf(h);
}
