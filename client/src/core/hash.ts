import { blake2b } from '@noble/hashes/blake2b';
import { type Json, canonicalize } from './canon.ts';
import { concat, toBytes, utf8 } from './bytes.ts';

export const PREFIX = 'CRT/v1';
export const CELL_DOMAIN = 'CRT/v1/cell';
export const SHARE_DOMAIN = 'CRT/v1/share';
export const DESCRIPTOR_DOMAIN = 'CRT/v1/descriptor';
export const CKB_PERSONALIZATION = 'ckb-default-hash';

/** blake2b with 32-byte digest; CKB personalization by default. */
export function blake2b256(data: Uint8Array, personalization: string = CKB_PERSONALIZATION): Uint8Array {
  return blake2b(data, { dkLen: 32, personalization: utf8(personalization) });
}

/** I = blake2b256("CRT/v1/cell" ‖ network_id ‖ T) (SPEC §2). `typeId` = T, bytes or 0x hex. */
export function identity(networkId: number, typeId: Uint8Array | string): Uint8Array {
  if (!Number.isInteger(networkId) || networkId < 0 || networkId > 255) throw new RangeError('network_id must be a byte');
  const t = toBytes(typeId);
  if (t.length !== 32) throw new RangeError('type id must be 32 bytes');
  return blake2b256(concat(utf8(CELL_DOMAIN), Uint8Array.of(networkId), t));
}

/** blake2b256("CRT/v1/share" ‖ share) (SPEC §7.1). */
export function shareCommitment(share: Uint8Array | string): Uint8Array {
  return blake2b256(concat(utf8(SHARE_DOMAIN), toBytes(share)));
}

/** blake2b256("CRT/v1/descriptor" ‖ JCS(descriptor)) (SPEC §8.1). */
export function descriptorHash(descriptor: Json): Uint8Array {
  return blake2b256(concat(utf8(DESCRIPTOR_DOMAIN), utf8(canonicalize(descriptor))));
}
