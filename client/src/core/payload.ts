import { type Bytes, bytesToHex, concat, toBytes, utf8 } from './bytes.ts';

/** "CRTS" ‖ 0x01 ‖ T (37 bytes) — payload of the keygen and heartbeat jobs (SPEC §3.3). */
export function jobPayload(T: Bytes | string): Uint8Array {
  const t = toBytes(T);
  if (t.length !== 32) throw new RangeError('T must be 32 bytes');
  return concat(utf8('CRTS'), Uint8Array.of(1), t);
}

export const RESULT_STATUSES = ['hold', 'keygen', 'recommit', 'release', 'done', 'cancelled', 'dropped', 'key_lost', 'bad_args', 'bad_payload'] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

/** "CRT1" ‖ status byte ‖ T (SPEC §5.3). T may be absent in results of `bad_args`/`bad_payload`. */
export function parseResult(bytes: Bytes | string): { status: ResultStatus; code: number; T: string | null } {
  const b = toBytes(bytes);
  if (b.length < 5 || b.length > 64 || new TextDecoder().decode(b.slice(0, 4)) !== 'CRT1') throw new Error('not a CRT result');
  const code = b[4]!;
  const status = RESULT_STATUSES[code];
  if (!status) throw new Error(`unknown result status ${code}`);
  if (b.length !== 5 && b.length !== 37) throw new Error('bad result length');
  return { status, code, T: b.length === 37 ? bytesToHex(b.slice(5)) : null };
}
