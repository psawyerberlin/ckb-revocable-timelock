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
