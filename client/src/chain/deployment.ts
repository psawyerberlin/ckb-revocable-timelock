import { loadDeployment as loadCsrDeployment, serviceId } from '../../vendor/csr-job.mjs';
import { bytesToHex, hexToBytes } from '../core/bytes.ts';
import type { Script } from './rpc.ts';

export class DeploymentError extends Error { constructor(m: string) { super(m); this.name = 'DeploymentError'; } }

export interface ScriptRef { code_hash: string; out_point: { tx_hash: string; index: number } }
export interface Deployment {
  network_id: number;
  node_lock: ScriptRef;
  crt_code_hash: string;
  crt_data_hash: string;
  crt_data_cell: { tx_hash: string; index: number };
  csr: {
    job_type: ScriptRef;
    job_lock: ScriptRef;
    registry_type_hash: string;
    registry_type_script: Script;
    /** the CSR deployment json as read by csr-job.mjs (`registry_type_hash`, `scripts.job_type`, `scripts.job_lock`) */
    deployment: any;
  };
  type_id_code_hash: string;
  rpc_urls: string[];
  monitor_url: string;
  /** optional override of the 10.8 s default used by the cost estimator */
  block_seconds?: number;
}

const isHex = (s: unknown, bytes?: number): s is string =>
  typeof s === 'string' && /^0x([0-9a-f]{2})*$/i.test(s) && (bytes === undefined || s.length === 2 + 2 * bytes);

function hash(v: unknown, what: string): string {
  if (!isHex(v, 32)) throw new DeploymentError(`${what}: expected 32-byte 0x hex`);
  return v.toLowerCase();
}
function outPoint(v: any, what: string) {
  if (!v || typeof v !== 'object') throw new DeploymentError(`${what}: missing`);
  if (!Number.isInteger(v.index) || v.index < 0) throw new DeploymentError(`${what}.index: invalid`);
  return { tx_hash: hash(v.tx_hash, `${what}.tx_hash`), index: v.index as number };
}
function scriptRef(v: any, what: string): ScriptRef {
  if (!v || typeof v !== 'object') throw new DeploymentError(`${what}: missing`);
  return { code_hash: hash(v.code_hash, `${what}.code_hash`), out_point: outPoint(v.out_point, `${what}.out_point`) };
}
function url(v: unknown, what: string): string {
  if (typeof v !== 'string') throw new DeploymentError(`${what}: expected URL`);
  let u: URL;
  try { u = new URL(v); } catch { throw new DeploymentError(`${what}: invalid URL`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new DeploymentError(`${what}: must be http(s)`);
  return v;
}

/** Validates the content of `deployments/<network>.json` (string or object). Every field is checked; a disabled network is refused. */
export function parseDeployment(json: unknown): Deployment {
  const d: any = typeof json === 'string' ? JSON.parse(json) : json;
  if (!d || typeof d !== 'object') throw new DeploymentError('deployment: not an object');
  if (d.enabled === false) throw new DeploymentError('deployment: CRT is not enabled on this network');
  if (!Number.isInteger(d.network_id) || d.network_id < 0 || d.network_id > 255) throw new DeploymentError('network_id: expected a byte');
  const csr = d.csr;
  if (!csr || typeof csr !== 'object') throw new DeploymentError('csr: missing');
  const rts = csr.registry_type_script;
  if (!rts || typeof rts !== 'object') throw new DeploymentError('csr.registry_type_script: missing');
  if (!['type', 'data', 'data1', 'data2'].includes(rts.hash_type)) throw new DeploymentError('csr.registry_type_script.hash_type: invalid');
  if (!isHex(rts.args)) throw new DeploymentError('csr.registry_type_script.args: invalid hex');
  let csrDep: any;
  try { csrDep = loadCsrDeployment(csr.deployment); } catch (e) { throw new DeploymentError(`csr.deployment: ${(e as Error).message}`); }
  if (!Array.isArray(d.rpc_urls) || d.rpc_urls.length === 0) throw new DeploymentError('rpc_urls: expected a non-empty list');
  if (d.block_seconds !== undefined && !(typeof d.block_seconds === 'number' && d.block_seconds > 0)) throw new DeploymentError('block_seconds: invalid');
  const out: Deployment = {
    network_id: d.network_id,
    node_lock: scriptRef(d.node_lock, 'node_lock'),
    crt_code_hash: hash(d.crt_code_hash, 'crt_code_hash'),
    crt_data_hash: hash(d.crt_data_hash, 'crt_data_hash'),
    crt_data_cell: outPoint(d.crt_data_cell, 'crt_data_cell'),
    csr: {
      job_type: scriptRef(csr.job_type, 'csr.job_type'),
      job_lock: scriptRef(csr.job_lock, 'csr.job_lock'),
      registry_type_hash: hash(csr.registry_type_hash, 'csr.registry_type_hash'),
      registry_type_script: { code_hash: hash(rts.code_hash, 'csr.registry_type_script.code_hash'), hash_type: rts.hash_type, args: rts.args.toLowerCase() },
      deployment: csrDep,
    },
    type_id_code_hash: hash(d.type_id_code_hash, 'type_id_code_hash'),
    rpc_urls: d.rpc_urls.map((u: unknown, i: number) => url(u, `rpc_urls[${i}]`)),
    monitor_url: url(d.monitor_url, 'monitor_url'),
  };
  if (d.block_seconds !== undefined) out.block_seconds = d.block_seconds;
  if (String(csrDep.registry_type_hash).toLowerCase() !== out.csr.registry_type_hash) throw new DeploymentError('csr.deployment.registry_type_hash differs from csr.registry_type_hash');
  return out;
}

/** Loads `deployments/<network>.json` from `dir` (Node only; browsers pass the parsed JSON to `parseDeployment`). */
export async function loadDeployment(network: string, dir = 'deployments'): Promise<Deployment> {
  if (!/^[a-z0-9_-]+$/.test(network)) throw new DeploymentError('invalid network name');
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  return parseDeployment(await readFile(join(dir, `${network}.json`), 'utf8'));
}

/** Service ID of the CRT service of runner `R`: serviceId(crtCodeHash, R, [crtDataHash]) (SPEC §5.1). */
export function crtServiceId(deployment: Pick<Deployment, 'crt_code_hash' | 'crt_data_hash'>, R: string | Uint8Array): string {
  const r = typeof R === 'string' ? R : bytesToHex(R);
  if (hexToBytes(r).length !== 32) throw new DeploymentError('R must be 32 bytes');
  return serviceId(deployment.crt_code_hash, r, [deployment.crt_data_hash]);
}
