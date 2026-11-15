import { SWITCH_PARAM_RANGES, CKB, type SwitchParams } from '@crt/client';

/** Everything the owner decides in the create flow. Amounts are shannons as decimal strings (JSON-safe). */
export interface Draft {
  network: string;
  /** unix seconds */
  deadline: number | null;
  n: number;
  t: number;
  /** runner lock hashes R */
  selected: string[];
  mandatory: string[];
  mandatoryJ: number;
  heartbeatBlocks: number;
  heartbeatTip: string;
  keygenTip: string;
  maxFee: string;
  organiserFee: string;
  /** what the owner typed in the "I understand" box */
  ack: string;
  created: CreatedInfo | null;
  armTx: string | null;
  kitSaved: boolean;
}

export interface CreatedNode { R: string; servicePubkey: string; peerId: string; label: string }
export interface CreatedInfo { T: string; I: string; txHash: string; deadline: number; nodes: CreatedNode[]; params: Record<string, string | number>; ownerLockHash: string }

const KEY = 'crt.draft';
const R = SWITCH_PARAM_RANGES;

export function defaultDraft(network = 'testnet'): Draft {
  return {
    network, deadline: null, n: R.n.default, t: R.t.default, selected: [], mandatory: [], mandatoryJ: 1,
    heartbeatBlocks: R.heartbeatBlocks.default, heartbeatTip: R.heartbeatTip.default.toString(), keygenTip: R.keygenTip.default.toString(),
    maxFee: R.maxFee.default.toString(), organiserFee: R.organiserFee.default.toString(), ack: '', created: null, armTx: null, kitSaved: false,
  };
}

let current: Draft | null = null;

export function getDraft(network: string): Draft {
  if (current && current.network === network) return current;
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) {
      const d = { ...defaultDraft(network), ...(JSON.parse(raw) as Partial<Draft>) };
      if (d.network === network) { current = d; return d; }
    }
  } catch { /* ignore */ }
  current = defaultDraft(network);
  return current;
}

export function saveDraft(d: Draft): void {
  current = d;
  try { sessionStorage.setItem(KEY, JSON.stringify(d)); } catch { /* ignore */ }
}

export function resetDraft(network: string): Draft {
  current = null;
  try { sessionStorage.removeItem(KEY); } catch { /* ignore */ }
  return getDraft(network);
}

export function switchParams(d: Draft): SwitchParams {
  return {
    heartbeatBlocks: d.heartbeatBlocks, heartbeatTip: BigInt(d.heartbeatTip), keygenTip: BigInt(d.keygenTip),
    maxFee: BigInt(d.maxFee), organiserFee: BigInt(d.organiserFee),
  };
}

export const ckbToShannons = (s: string): bigint | null => {
  const m = /^\s*(\d+)(?:\.(\d{1,8}))?\s*$/.exec(s);
  if (!m) return null;
  return BigInt(m[1]!) * CKB + BigInt((m[2] ?? '').padEnd(8, '0') || '0');
};

export const shannonsToCkb = (s: bigint | string): string => {
  const v = BigInt(s);
  const frac = (v % CKB).toString().padStart(8, '0').replace(/0+$/, '');
  return `${v / CKB}${frac ? '.' + frac : ''}`;
};
