// Recover: no wallet needed. T or a kit → read releases → which leaves released, K when possible, else the headroom shortfall.
import {
  bytesToHex, collectReleases, leafPositions, unwrapAllReport, type Descriptor, type Envelope, type UnwrapReport,
} from '@crt/client';
import { el, short } from './dom.ts';
import { getDeployment } from './deployments.ts';
import { download } from './flow.ts';
import { parseKit } from './kitfile.ts';
import { session } from './session.ts';

const err = (e: unknown) => (e instanceof Error ? e.message : String(e));
const state: { kit: { descriptor: Descriptor; envelopes: Envelope[] } | null } = { kit: null };

/** Hands K to the page's application slot (`window.crtApplication.onKey(K)`), if an application registered one. */
export function handOverToApplication(K: Uint8Array): boolean {
  const app = (window as unknown as { crtApplication?: { onKey?: (k: Uint8Array) => void } }).crtApplication;
  if (typeof app?.onKey !== 'function') return false;
  app.onKey(K);
  return true;
}

export function shortfallText(r: UnwrapReport): string {
  const h = r.headroom;
  const parts = [`threshold headroom ${h.threshold}`];
  if (h.mandatory !== null) parts.push(`mandatory headroom ${h.mandatory}`);
  const short_ = Math.max(0, -h.overall);
  return `Not recoverable yet: ${parts.join(', ')}. ${short_ > 0 ? `${short_} more released leaf${short_ === 1 ? ' is' : 's are'} needed. ` : ''}${r.message}`;
}

export function renderRecover(host: HTMLElement): void {
  const tIn = el('input', { type: 'text', id: 'recover-t', autocomplete: 'off', placeholder: '0x… (T, 32 bytes)', size: '70' });
  const file = el('input', { type: 'file', id: 'recover-kit', accept: '.html,text/html' });
  const out = el('div', { id: 'recover-out', 'aria-live': 'polite' });
  const kitNote = el('p', { class: 'muted', id: 'recover-kit-note' }, 'No kit loaded: without it the released keys can be listed but K cannot be computed.');
  const go = el('button', { type: 'button', class: 'primary', id: 'recover-go' }, 'Read releases');

  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    try {
      state.kit = parseKit(await f.text());
      tIn.value = state.kit.descriptor.type_id;
      kitNote.textContent = `Kit loaded: switch ${short(state.kit.descriptor.type_id)}, ${state.kit.descriptor.nodes.length} runners.`;
    } catch (e) { state.kit = null; kitNote.textContent = err(e); kitNote.className = 'err'; }
  });

  go.addEventListener('click', async () => {
    out.replaceChildren(el('p', { role: 'status' }, 'Reading the Node Cells…'));
    try {
      const T = (state.kit?.descriptor.type_id ?? tIn.value).trim().toLowerCase();
      if (!/^0x[0-9a-f]{64}$/.test(T)) throw new Error('Paste T (0x + 64 hex digits) or load a kit.');
      const dep = getDeployment(session.network);
      const releases = await collectReleases(T, dep.rpc_urls, { nodeLockCodeHash: dep.node_lock.code_hash });
      const box = el('div');
      box.append(el('p', {}, `${releases.size} released key${releases.size === 1 ? '' : 's'} found on chain for ${short(T)}.`));
      const k = state.kit;
      if (!k) {
        const ul = el('ul');
        for (const R of releases.keys()) ul.append(el('li', {}, `runner ${short(R)} released`));
        box.append(ul, el('p', { class: 'note' }, 'Load the recovery kit to compute K: the envelopes are in the kit, not on chain.'));
      } else {
        const rep = await unwrapAllReport(k.descriptor, k.envelopes, releases);
        const pos = new Map(leafPositions(k.descriptor.access_tree).map((p) => [p.position, p]));
        const tbl = el('table', { class: 'runners', id: 'leaves' }, el('tr', {}, el('th', {}, 'Leaf'), el('th', {}, 'Runner'), el('th', {}, 'Status')));
        for (const l of rep.leaves) {
          const label = k.descriptor.nodes[pos.get(l.position)?.node ?? l.node]?.label;
          tbl.append(el('tr', {}, el('td', {}, String(l.position)), el('td', {}, label ?? short(l.runner_lock_hash)), el('td', {}, l.status === 'ok' ? 'released' : `${l.status}${l.reason ? ` — ${l.reason}` : ''}`)));
        }
        box.append(el('div', { class: 'scroll' }, tbl));
        if (rep.K) {
          const K = rep.K;
          const hexK = bytesToHex(K);
          const dl = el('button', { type: 'button', class: 'primary', id: 'download-k' }, 'Download K (hex)');
          dl.addEventListener('click', () => download(`crt-K-${T.slice(2, 10)}.hex`, hexK + '\n', 'text/plain'));
          const app = el('button', { type: 'button', id: 'handover' }, 'Hand K to the application slot');
          const st = el('span', { role: 'status', class: 'muted' });
          app.addEventListener('click', () => { st.textContent = handOverToApplication(K) ? 'K handed to window.crtApplication.' : 'No application slot (window.crtApplication) is present on this page.'; });
          box.append(el('p', {}, el('strong', {}, 'K recovered. ')), el('p', { class: 'note' }, 'K is the secret. Anyone who sees it can use it. It is shown nowhere and kept in memory only.'), el('div', { class: 'row' }, dl, app, st));
        } else box.append(el('p', { class: 'note', id: 'shortfall' }, shortfallText(rep)));
      }
      out.replaceChildren(box);
    } catch (e) { out.replaceChildren(el('p', { class: 'err', role: 'alert' }, err(e))); }
  });

  host.append(
    el('section', { class: 'panel' },
      el('h2', {}, 'Recover'),
      el('p', {}, 'No wallet needed. Paste the switch id T or load your recovery kit; the app reads the released keys from the chain.'),
      el('div', { class: 'field' }, el('label', { for: 'recover-t' }, 'Switch id T'), tIn),
      el('div', { class: 'field' }, el('label', { for: 'recover-kit' }, 'Recovery kit (crt-kit-….html)'), file, kitNote),
      go, out));
}
