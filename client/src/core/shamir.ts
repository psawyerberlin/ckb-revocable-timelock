import { type Rng, defaultRng } from './bytes.ts';

// GF(2^8) with reduction polynomial x^8 + x^4 + x^3 + x + 1 = 0x11b.
const POLY = 0x11b;

function gmul(a: number, b: number): number {
  let r = 0;
  while (b) {
    if (b & 1) r ^= a;
    a <<= 1;
    if (a & 0x100) a ^= POLY;
    b >>= 1;
  }
  return r;
}

function ginv(a: number): number {
  if (a === 0) throw new Error('inverse of zero');
  let r = 1;
  for (let i = 0; i < 254; i++) r = gmul(r, a); // a^254
  return r;
}

/** Split a secret byte string into n shares, any t of which recover it. share = x ‖ y[len], x = 1..n. */
export function split(secret: Uint8Array, t: number, n: number, rng: Rng = defaultRng): Uint8Array[] {
  if (!Number.isInteger(t) || !Number.isInteger(n) || t < 1 || t > n || n > 255) throw new RangeError('need 1 <= t <= n <= 255');
  const len = secret.length;
  const coeffs: Uint8Array[] = [];
  for (let j = 1; j < t; j++) {
    const c = rng(len);
    if (c.length !== len) throw new Error('rng returned wrong length');
    coeffs.push(c);
  }
  const shares: Uint8Array[] = [];
  for (let x = 1; x <= n; x++) {
    const s = new Uint8Array(1 + len);
    s[0] = x;
    for (let i = 0; i < len; i++) {
      // Horner: ((c_{t-1} x + ... ) x + c_1) x + secret
      let y = 0;
      for (let j = t - 1; j >= 1; j--) y = gmul(y, x) ^ coeffs[j - 1]![i]!;
      s[1 + i] = gmul(y, x) ^ secret[i]!;
    }
    shares.push(s);
  }
  return shares;
}

/**
 * Lagrange interpolation at 0 over all given shares. Does NOT detect wrong shares or too few of them
 * (the result is then garbage): callers check `shareCommitment` and the threshold.
 */
export function combine(shares: Uint8Array[]): Uint8Array {
  if (shares.length === 0) throw new Error('no shares');
  const len = shares[0]!.length - 1;
  if (len < 0) throw new Error('empty share');
  const xs = shares.map((s) => {
    if (s.length !== len + 1) throw new Error('shares differ in length');
    if (s[0] === 0) throw new Error('share x must be non-zero');
    return s[0]!;
  });
  if (new Set(xs).size !== xs.length) throw new Error('duplicate share index');
  const basis = xs.map((xi, i) => {
    let num = 1, den = 1;
    xs.forEach((xj, j) => { if (j !== i) { num = gmul(num, xj); den = gmul(den, xi ^ xj); } });
    return gmul(num, ginv(den));
  });
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    let acc = 0;
    shares.forEach((s, k) => { acc ^= gmul(s[1 + i]!, basis[k]!); });
    out[i] = acc;
  }
  return out;
}
