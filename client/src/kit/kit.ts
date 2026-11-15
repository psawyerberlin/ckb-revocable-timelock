// Recovery kit generator (SPEC §8.2): one self-contained HTML file from {descriptor, envelopes, application}.
import { hexToBytes } from '../core/bytes.ts';
import type { AccessTree } from '../core/tree.ts';
import { leafPositions } from '../core/tree.ts';
import { KIT_RECOVERY_JS, KIT_TEMPLATE } from './assets.generated.ts';
import { type Descriptor, type Envelope, descriptorHash, validateDescriptor } from './descriptor.ts';

/** The kit format this library generates. Same version + same inputs ⇒ same bytes. */
export const KIT_VERSION = '1';

/** Public CKB JSON-RPC endpoints pre-filled in the kit (user-editable in the page). */
export const DEFAULT_KIT_RPC_URLS: Record<number, string[]> = {
  0: ['https://mainnet.ckb.dev/'],
  1: ['https://testnet.ckb.dev/'],
  2: ['http://127.0.0.1:8114/'],
};
const NETWORK_NAMES: Record<number, string> = { 0: 'CKB mainnet', 1: 'CKB testnet (Pudge)', 2: 'CKB devnet' };

export interface KitApplication {
  name: string;
  version: string;
  /** any JSON value; exposed as `window.CRT_KIT.application.payload` */
  payload?: unknown;
  /** JavaScript source appended after the kit's own script (sets `window.crtApplication = { onKey(K) { … } }`) */
  script?: string;
}

export interface GenerateKitInput {
  descriptor: Descriptor;
  envelopes: Envelope[];
  application?: KitApplication;
  kitVersion: string;
  /** deadline at generation time (unix seconds), printed on the certificate; renewals move it on chain */
  deadline?: number | bigint;
  /** RPC endpoints pre-filled in the page; defaults to `DEFAULT_KIT_RPC_URLS[network_id]` */
  rpcUrls?: string[];
}

export class KitError extends Error { constructor(m: string) { super(m); this.name = 'KitError'; } }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => [k, sortKeys(o[k])]));
  }
  return v;
}

/** JSON safe inside `<script type="application/json">`: sorted keys, `<`, `>`, `&`, U+2028/9 escaped. */
function scriptJson(v: unknown): string {
  return JSON.stringify(sortKeys(v), null, 1)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

const iso = (s: number | bigint) => new Date(Number(s) * 1000).toISOString().replace('.000Z', 'Z');

function treeHtml(tree: AccessTree, d: Descriptor): string {
  const pos = leafPositions(tree);
  const name = (node: number) => {
    const n = d.nodes[node]!;
    return esc(n.label ?? `runner ${n.runner_lock_hash.slice(0, 10)}…`);
  };
  const branch = (b: { t: number; n: number }, i: number) => {
    const leaves = pos.filter((p) => p.branch === i).map((p) => `<li>leaf ${p.position}: node ${p.node} (${name(p.node)})</li>`).join('');
    return `any <strong>${b.t} of ${b.n}</strong><ul>${leaves}</ul>`;
  };
  if (tree.kind === 'threshold') return `<div class="tree">${branch(tree, 0)}</div>`;
  return `<div class="tree">all of the following groups (each group is needed):<ul>${tree.branches.map((b, i) => `<li>group ${i + 1}: ${branch(b, i)}</li>`).join('')}</ul></div>`;
}

function certificate(d: Descriptor, hash: string, input: GenerateKitInput): string {
  const app = input.application;
  const rows: [string, string][] = [
    ['Network', `${esc(NETWORK_NAMES[d.network_id] ?? 'network')} (network_id ${d.network_id})`],
    ['Created', esc(iso(d.created_at))],
    ['Deadline', input.deadline === undefined ? 'not recorded in this kit — read it from the chain (button below)'
      : `${esc(iso(input.deadline))} <em>(when this kit was made; every renewal moves it later)</em>`],
    ['Switch id (T)', `<code>${d.type_id}</code>`],
    ['Identity (I)', `<code>${d.identity}</code>`],
    ['Descriptor hash', `<code id="crt-printed-hash">${hash}</code>`],
    ['Alive Cell', `<code>${d.alive_cell.tx_hash}</code> output ${d.alive_cell.index}`],
    ['Node lock code hash', `<code>${d.deployment.node_lock_code_hash}</code>`],
  ];
  if (app) rows.push(['Application', `${esc(app.name)} ${esc(app.version)}`]);
  if (d.coordinator_url) rows.push(['Coordinator (informational)', `<code>${esc(d.coordinator_url)}</code>`]);
  const nodes = d.nodes.map((n, i) => `<tr><td>${i}</td><td>${esc(n.label ?? '')}${n.peer_id ? `<br><span class="mono">${esc(n.peer_id)}</span>` : ''}</td>` +
    `<td><code>${n.runner_lock_hash}</code></td><td><code>${n.pubkey}</code></td><td><code>${n.node_cell.tx_hash}</code> output ${n.node_cell.index}</td></tr>`).join('\n');
  return `<h2>The switch</h2>
<table>
${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('\n')}
</table>
<h2>Who holds the key parts</h2>
<p>The secret was split between independent computers ("runners"). It can be put back together from the parts of:</p>
${treeHtml(d.access_tree, d)}
<table>
<tr><th>#</th><th>Runner</th><th>Runner id (R)</th><th>Node public key</th><th>Node Cell</th></tr>
${nodes}
</table>
<h2>What to do</h2>
<ol>
<li>The owner of this switch set a deadline. As long as the owner renews it, nothing happens and nobody can open the secret.</li>
<li>If the deadline passes without renewal (plus one day of grace), each runner automatically publishes its key part on the
CKB blockchain, a public ledger that anyone can read. If the owner cancelled the switch, nothing is ever published.</li>
<li>Open this file in any web browser, on any computer. You do not need to install anything or to have an account.</li>
<li>Check that the box at the top says <strong>MATCH</strong>. If it says MISMATCH, this file was altered: do not use it.</li>
<li>Press <strong>Check the switch</strong>, then <strong>Recover from the chain</strong>. The file reads the published parts from the
addresses listed, checks every part, and shows the key when enough parts are available.</li>
<li>Without internet: ask someone to read the released values from the blockchain (cells locked with the node lock code hash
above, whose arguments start with the switch id T) and paste them into the offline box.</li>
<li>If the public addresses stop working, replace them with any CKB node of the network shown above.</li>
</ol>`;
}

function checkEnvelopes(d: Descriptor, envelopes: Envelope[]): void {
  const pos = leafPositions(d.access_tree);
  if (!Array.isArray(envelopes) || envelopes.length !== pos.length) throw new KitError(`expected ${pos.length} envelopes (one per leaf)`);
  pos.forEach((p) => {
    const e = envelopes.find((x) => x.position === p.position);
    if (!e) throw new KitError(`no envelope for leaf ${p.position}`);
    if (e.node !== p.node || e.runner_lock_hash !== d.nodes[p.node]!.runner_lock_hash) throw new KitError(`envelope ${p.position} is for another node`);
    let b: Uint8Array;
    try { b = hexToBytes(e.envelope); } catch { throw new KitError(`envelope ${p.position} is not hex`); }
    if (b.length < 33 + 12 + 16) throw new KitError(`envelope ${p.position} is too short`);
  });
}

/** Fills `%%NAME%%` markers without `String.replace` pattern semantics (`$` in the bundle stays as is). */
function fill(template: string, values: Record<string, string>): string {
  return template.split(/%%([A-Z_]+)%%/).map((part, i) => {
    if (i % 2 === 0) return part;
    const v = values[part];
    if (v === undefined) throw new KitError(`template marker ${part} has no value`);
    return v;
  }).join('');
}

/** Generates `crt-kit.html`. Deterministic: identical inputs give identical bytes. */
export function generateKit(input: GenerateKitInput): string {
  if (input.kitVersion !== KIT_VERSION) throw new KitError(`this library generates kit version ${KIT_VERSION}, not ${input.kitVersion}`);
  const d = validateDescriptor(input.descriptor);
  checkEnvelopes(d, input.envelopes);
  const app = input.application;
  if (app && (typeof app.name !== 'string' || typeof app.version !== 'string')) throw new KitError('application needs name and version');
  if (app?.script !== undefined && /<\/script/i.test(app.script)) throw new KitError('application script must not contain "</script"');
  const rpcUrls = input.rpcUrls ?? DEFAULT_KIT_RPC_URLS[d.network_id] ?? [];
  const hash = descriptorHash(d);
  const envelopes = leafPositions(d.access_tree).map((p) => {
    const e = input.envelopes.find((x) => x.position === p.position)!;
    return { position: e.position, node: e.node, runner_lock_hash: e.runner_lock_hash, envelope: e.envelope.toLowerCase() };
  });
  return fill(KIT_TEMPLATE, {
    KIT_VERSION: esc(KIT_VERSION),
    SHORT_ID: esc(d.type_id.slice(0, 18)),
    CERTIFICATE: certificate(d, hash, input),
    RPC_URLS: esc(rpcUrls.join('\n')),
    DESCRIPTOR_JSON: scriptJson(d),
    ENVELOPES_JSON: scriptJson(envelopes),
    APPLICATION_JSON: scriptJson(app ? { name: app.name, version: app.version, payload: app.payload ?? null } : null),
    RECOVERY_JS: KIT_RECOVERY_JS,
    APPLICATION_SCRIPT: app?.script !== undefined ? `<script id="crt-application-script">\n${app.script}\n</script>` : '',
  });
}
