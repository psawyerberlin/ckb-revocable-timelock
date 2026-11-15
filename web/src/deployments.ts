import { parseDeployment, type CrtListEntry, type Deployment } from '@crt/client';
import type { NetworkName } from './networks.ts';

const files = import.meta.glob('../../deployments/*.json', { eager: true, import: 'default' }) as Record<string, unknown>;
const byName = (name: string): unknown => files[`../../deployments/${name}.json`];

export class NoDeployment extends Error {
  constructor(network: string) { super(`No deployment file for ${network}: deployments/${network}.json is missing or not enabled.`); }
}

/** Parsed `deployments/<network>.json`; throws `NoDeployment` when it is absent, disabled or invalid. */
export function getDeployment(network: NetworkName): Deployment {
  const raw = byName(network);
  if (raw === undefined) throw new NoDeployment(network);
  try { return parseDeployment(raw); } catch (e) { throw new NoDeployment(`${network} (${e instanceof Error ? e.message : String(e)})`); }
}

export function getRunnerList(network: NetworkName): CrtListEntry[] {
  const raw = byName(`${network}-runners`);
  return Array.isArray(raw) ? (raw as CrtListEntry[]) : [];
}

/** Optional organiser address of this build (`VITE_CRT_ORGANISER_ADDRESS`); the organiser fee needs one. */
export const ORGANISER_ADDRESS: string = (import.meta.env?.VITE_CRT_ORGANISER_ADDRESS as string | undefined) ?? '';
