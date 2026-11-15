import type { CreatedInfo } from './draft.ts';

const KEY = 'crt.switches';
export interface LocalSwitch { T: string; network: string; deadline: number; createdAt: number; txHash: string; nodes: CreatedInfo['nodes']; params: CreatedInfo['params']; armTx?: string }

export function listSwitches(): LocalSwitch[] {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

/** The local list of switches, keyed by `T` (used by "My switches"). */
export function rememberSwitch(network: string, c: CreatedInfo, armTx?: string): void {
  const all = listSwitches().filter((s) => s.T.toLowerCase() !== c.T.toLowerCase());
  all.push({ T: c.T, network, deadline: c.deadline, createdAt: Math.floor(Date.now() / 1000), txHash: c.txHash, nodes: c.nodes, params: c.params, ...(armTx && { armTx }) });
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* ignore */ }
}

const KITS = 'crt.kits';
const kitMap = (): Record<string, string> => { try { const v = JSON.parse(localStorage.getItem(KITS) ?? '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
/** The kit (encrypted envelopes only, no secret) is kept per `T` so "Download kit again" works. */
export function storeKit(T: string, html: string): void {
  const m = kitMap(); m[T.toLowerCase()] = html;
  try { localStorage.setItem(KITS, JSON.stringify(m)); } catch { /* quota: ignore */ }
}
export const storedKit = (T: string): string | null => kitMap()[T.toLowerCase()] ?? null;

export function addSwitchByT(network: string, T: string): LocalSwitch {
  const t = T.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(t)) throw new Error('T must be 0x followed by 64 hex digits.');
  const all = listSwitches();
  const have = all.find((s) => s.T.toLowerCase() === t);
  if (have) return have;
  const s: LocalSwitch = { T: t, network, deadline: 0, createdAt: Math.floor(Date.now() / 1000), txHash: '', nodes: [], params: {} };
  all.push(s);
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* ignore */ }
  return s;
}

export function forgetSwitch(T: string): void {
  try { localStorage.setItem(KEY, JSON.stringify(listSwitches().filter((s) => s.T.toLowerCase() !== T.toLowerCase()))); } catch { /* ignore */ }
}
