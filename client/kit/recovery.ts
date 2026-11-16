// Entry point of the code embedded in every recovery kit (bundled to one IIFE by scripts/build-kit.mjs).
// Zero network access except the CKB JSON-RPC URLs the user lists in the page.
import { bytesToHex, hexToBytes } from '../src/core/bytes.ts';
import { type Descriptor, type Envelope, RecoveryError, descriptorHash, unwrapAll, validateDescriptor } from '../src/kit/descriptor.ts';
import { collectReleases, parseReleases, readSwitchOnline } from '../src/kit/recover.ts';

interface KitApplication { name: string; version: string; payload: unknown }
interface CrtKit {
  version?: string;
  descriptor?: Descriptor;
  envelopes?: Envelope[];
  application?: KitApplication;
  api?: {
    readSwitch(rpcUrls?: string[]): ReturnType<typeof readSwitchOnline>;
    collectReleases(rpcUrls?: string[]): Promise<Map<string, string>>;
    recover(releases?: Map<string, string | Uint8Array> | string[]): Promise<Uint8Array>;
  };
}
declare global {
  interface Window { CRT_KIT?: CrtKit; crtApplication?: { onKey?(K: Uint8Array): unknown } }
}

const w = window;
const el = (id: string): HTMLElement | null => document.getElementById(id);
const json = (id: string): unknown => { const e = el(id); return e && e.textContent ? JSON.parse(e.textContent) : null; };
const setText = (id: string, text: string) => { const e = el(id); if (e) e.textContent = text; };
const status = (text: string) => setText('crt-status', text);

const descriptor = json('crt-descriptor') as Descriptor;
const envelopes = (json('crt-envelopes') ?? []) as Envelope[];
const application = json('crt-application-data') as KitApplication | null;

const kit: CrtKit = (w.CRT_KIT = w.CRT_KIT ?? {});
kit.version = el('crt-recovery')?.getAttribute('data-kit-version') ?? undefined;
kit.descriptor = descriptor;
kit.envelopes = envelopes;
if (application) kit.application = application;

function rpcUrls(given?: string[]): string[] {
  if (given && given.length) return given;
  const t = el('crt-rpc-urls') as HTMLTextAreaElement | null;
  const urls = (t?.value ?? t?.textContent ?? '').split(/\s+/).filter(Boolean);
  if (!urls.length) throw new Error('no RPC address given');
  return urls;
}

/** A 64-hex-digit value (with or without 0x) as 32 bytes, else null. */
function asKey(v: string): Uint8Array | null {
  const s = v.trim().toLowerCase().replace(/^0x/, '');
  return /^[0-9a-f]{64}$/.test(s) ? hexToBytes('0x' + s) : null;
}

async function deliver(K: Uint8Array): Promise<Uint8Array> {
  setText('crt-key', bytesToHex(K));
  if (w.crtApplication?.onKey) await w.crtApplication.onKey(K);
  return K;
}

kit.api = {
  readSwitch: (urls) => readSwitchOnline(descriptor, rpcUrls(urls)),
  collectReleases: (urls) => collectReleases(descriptor.type_id, rpcUrls(urls), { nodeLockCodeHash: descriptor.deployment.node_lock_code_hash }),
  async recover(releases) {
    let map: Map<string, string | Uint8Array>;
    if (releases instanceof Map) map = releases;
    else if (Array.isArray(releases)) map = parseReleases(descriptor, releases).releases;
    else map = await kit.api!.collectReleases();
    return deliver(await unwrapAll(descriptor, envelopes, map));
  },
};

function explain(e: unknown): string {
  if (e instanceof RecoveryError) {
    return [e.report.message, '', ...e.report.leaves.map((l) => `leaf ${l.position}  ${l.runner_lock_hash}  ${l.status}: ${l.reason}`)].join('\n');
  }
  return e instanceof Error ? e.message : String(e);
}

function selfVerify(): void {
  const banner = el('crt-verify');
  const printed = (el('crt-printed-hash')?.textContent ?? '').trim().toLowerCase();
  let ok = false;
  let detail = '';
  try {
    validateDescriptor(descriptor);
    const h = descriptorHash(descriptor);
    ok = h === printed;
    detail = ok ? `descriptor hash ${h}` : `embedded descriptor hashes to ${h}, certificate says ${printed || '(nothing)'}`;
  } catch (e) { detail = explain(e); }
  if (banner) {
    banner.textContent = `${ok ? 'MATCH' : 'MISMATCH'} — ${detail}`;
    banner.className = `banner ${ok ? 'match' : 'mismatch'}`;
  }
}

async function run(what: string, f: () => Promise<string>): Promise<void> {
  status(`${what}…`);
  try { status(await f()); } catch (e) { status(`${what} failed:\n${explain(e)}`); }
}

function wire(): void {
  selfVerify();
  el('crt-btn-check')?.addEventListener('click', () => run('Reading the switch', async () => {
    const s = await kit.api!.readSwitch();
    const date = s.deadline === null ? 'Node Cells disagree' : new Date(Number(s.deadline) * 1000).toISOString();
    return [
      `Alive Cell: ${s.alive ? 'live (the owner has not cancelled)' : 'not found (cancelled, or wrong network)'}`,
      `Node Cells: ${s.nodes.length}, released: ${s.released}`,
      `Deadline on chain: ${date}`,
      `Descriptor hash on chain: ${s.descriptorHashMatches ? 'MATCH' : 'MISMATCH'}`,
    ].join('\n');
  }));
  el('crt-btn-online')?.addEventListener('click', () => run('Recovering from the chain', async () => {
    const K = await kit.api!.recover();
    return `Key recovered (${bytesToHex(K)}).`;
  }));
  el('crt-btn-offline')?.addEventListener('click', () => run('Recovering from pasted values', async () => {
    const t = el('crt-paste') as HTMLTextAreaElement | null;
    const lines = (t?.value ?? '').split('\n');
    const { releases, unmatched } = parseReleases(descriptor, lines);
    const short = (v: string): string => (v.length > 20 ? `${v.slice(0, 10)}…${v.slice(-6)}` : v);
    if (unmatched.length && releases.size === 0) {
      // No guardian's value: one 32-byte value may be the recovered key K itself (kept from an earlier opening).
      const k = unmatched.length === 1 ? asKey(unmatched[0]!) : null;
      if (k) {
        if (w.crtApplication?.onKey) {
          const ok = await w.crtApplication.onKey(k);
          if (ok !== false) { setText('crt-key', bytesToHex(k)); return 'Opened with the recovered key (no chain needed).'; }
        } else {
          setText('crt-key', bytesToHex(k));
          return 'Used as the recovered key; this kit has no application that could check it.';
        }
      }
      throw new Error(`${unmatched.map(short).join(', ')}: neither the release value of a guardian of this switch nor its `
        + 'recovered key. Paste the private key a guardian published in its released Node Cell (the last 32 bytes of '
        + 'the cell data), or the key recovered earlier.');
    }
    const K = await kit.api!.recover(lines);
    return `Key recovered (${bytesToHex(K)}).${unmatched.length ? `\nIgnored ${unmatched.length} value(s) that match no node.` : ''}`;
  }));
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
else wire();
