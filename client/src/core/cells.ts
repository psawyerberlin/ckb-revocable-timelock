import { type Bytes, bytesToHex, hexToBytes, toBytes } from './bytes.ts';

export const NODE_CELL_DATA_LEN = 139;
export const NODE_CELL_VERSION = 1;
export const ALIVE_CELL_DATA = Uint8Array.of(0x43, 0x52, 0x54, 0x01); // "CRT" ‖ 1
export const GRACE_SECONDS = 86_400;
/** CKB system type-id script: code_hash, hash_type `type` (SPEC §2). */
export const TYPE_ID_CODE_HASH = '0x00000000000000000000000000000000000000000000000000545950455f4944';

export type NodeState = 0 | 1 | 2;
export interface NodeCellData {
  version: number;
  state: NodeState;
  /** unix seconds */
  deadline: bigint;
  /** 32-byte values and the pubkey are 0x hex strings */
  ownerLockHash: string;
  descriptorHash: string;
  pubkey: string;
  privkey: string;
}

const ZERO32 = '0x' + '00'.repeat(32);
const ZERO33 = '0x' + '00'.repeat(33);

function field(hex: string, len: number, what: string): Uint8Array {
  const b = hexToBytes(hex);
  if (b.length !== len) throw new RangeError(`${what} must be ${len} bytes`);
  return b;
}

export function encodeNodeCellData(d: NodeCellData): Uint8Array {
  if (d.version !== NODE_CELL_VERSION) throw new RangeError('unsupported version');
  if (![0, 1, 2].includes(d.state)) throw new RangeError('invalid state');
  if (d.deadline < 0n || d.deadline >= 1n << 64n) throw new RangeError('deadline out of range');
  const out = new Uint8Array(NODE_CELL_DATA_LEN);
  out[0] = d.version;
  out[1] = d.state;
  new DataView(out.buffer).setBigUint64(2, d.deadline, true);
  out.set(field(d.ownerLockHash, 32, 'ownerLockHash'), 10);
  out.set(field(d.descriptorHash, 32, 'descriptorHash'), 42);
  out.set(field(d.pubkey, 33, 'pubkey'), 74);
  out.set(field(d.privkey, 32, 'privkey'), 107);
  return out;
}

export function decodeNodeCellData(data: Uint8Array | string): NodeCellData {
  const b = toBytes(data);
  if (b.length !== NODE_CELL_DATA_LEN) throw new RangeError(`node cell data must be ${NODE_CELL_DATA_LEN} bytes, got ${b.length}`);
  if (b[0] !== NODE_CELL_VERSION) throw new RangeError(`unsupported node cell version ${b[0]}`);
  if (b[1]! > 2) throw new RangeError(`invalid node cell state ${b[1]}`);
  return {
    version: b[0]!,
    state: b[1] as NodeState,
    deadline: new DataView(b.buffer, b.byteOffset, b.length).getBigUint64(2, true),
    ownerLockHash: bytesToHex(b.slice(10, 42)),
    descriptorHash: bytesToHex(b.slice(42, 74)),
    pubkey: bytesToHex(b.slice(74, 107)),
    privkey: bytesToHex(b.slice(107, 139)),
  };
}

/** A fresh (state 0) Node Cell: zero descriptor hash, pubkey and privkey. */
export function newNodeCellData(deadline: bigint, ownerLockHash: string): NodeCellData {
  return { version: NODE_CELL_VERSION, state: 0, deadline, ownerLockHash, descriptorHash: ZERO32, pubkey: ZERO33, privkey: ZERO32 };
}

/** The 4 immutable data bytes of the Alive Cell. */
export function aliveCellData(): Uint8Array {
  return ALIVE_CELL_DATA.slice();
}

/** True when the cell's data is exactly the Alive Cell marker. Accepts `{data}` or `{outputData}` (bytes or hex). */
export function isAliveCell(cell: { data?: Bytes | string; outputData?: Bytes | string }): boolean {
  const raw = cell.data ?? cell.outputData;
  if (raw === undefined) return false;
  try {
    const b = toBytes(raw);
    return b.length === 4 && b.every((x, i) => x === ALIVE_CELL_DATA[i]);
  } catch { return false; }
}

/** CKB `since` for an absolute timestamp (metric flag 0b10, absolute): 0x40 ‖ seconds. */
export function sinceAbsoluteTimestamp(seconds: number | bigint): bigint {
  const s = BigInt(seconds);
  if (s < 0n || s >= 1n << 56n) throw new RangeError('seconds out of range');
  return (0x40n << 56n) | s;
}
