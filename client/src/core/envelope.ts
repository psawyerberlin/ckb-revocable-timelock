import * as secp from '@noble/secp256k1';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { type Rng, concat, defaultRng, utf8 } from './bytes.ts';

export const ENV_SALT = 'CRT-ENV-v1';
const NONCE_LEN = 12;
const PUB_LEN = 33;

/** key = HKDF-SHA256(ikm = s, salt = "CRT-ENV-v1", info = E ‖ P, L = 32) (SPEC §7.2). */
export function envelopeKey(s: Uint8Array, E: Uint8Array, P: Uint8Array): Uint8Array {
  return hkdf(sha256, s, utf8(ENV_SALT), concat(E, P), 32);
}

function sharedX(priv: Uint8Array, pub: Uint8Array): Uint8Array {
  return secp.getSharedSecret(priv, pub, true).slice(1);
}

async function aesKey(raw: Uint8Array, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, [usage]);
}

function freshKeyPair(rng: Rng): { e: Uint8Array; E: Uint8Array } {
  for (let i = 0; i < 64; i++) {
    const e = rng(32);
    if (secp.utils.isValidPrivateKey(e)) return { e, E: secp.getPublicKey(e, true) };
  }
  throw new Error('rng did not produce a valid secp256k1 key');
}

/** envelope = E (33) ‖ nonce (12) ‖ AES-256-GCM(key, nonce, aad, m) with tag. `aad` = I ‖ tree_position (u16 BE). */
export async function wrap(pubkey33: Uint8Array, m: Uint8Array, aad: Uint8Array, rng: Rng = defaultRng): Promise<Uint8Array> {
  if (pubkey33.length !== PUB_LEN) throw new RangeError('pubkey must be 33 bytes');
  const { e, E } = freshKeyPair(rng);
  const key = envelopeKey(sharedX(e, pubkey33), E, pubkey33);
  const nonce = rng(NONCE_LEN);
  const ct = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce as BufferSource, additionalData: aad as BufferSource },
    await aesKey(key, 'encrypt'), m as BufferSource);
  return concat(E, nonce, new Uint8Array(ct));
}

/** Throws when the envelope is malformed, tampered with, or `aad`/`privkey32` do not match. */
export async function unwrap(privkey32: Uint8Array, envelope: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  if (envelope.length < PUB_LEN + NONCE_LEN + 16) throw new Error('envelope too short');
  const E = envelope.slice(0, PUB_LEN);
  const nonce = envelope.slice(PUB_LEN, PUB_LEN + NONCE_LEN);
  const ct = envelope.slice(PUB_LEN + NONCE_LEN);
  const P = secp.getPublicKey(privkey32, true);
  const key = envelopeKey(sharedX(privkey32, E), E, P);
  try {
    const pt = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce as BufferSource, additionalData: aad as BufferSource },
      await aesKey(key, 'decrypt'), ct as BufferSource);
    return new Uint8Array(pt);
  } catch {
    throw new Error('envelope: authentication failed (wrong key, wrong aad or tampered)');
  }
}
