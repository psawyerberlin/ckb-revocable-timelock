// My switches: a local list keyed by T (+ "add by T"), live state per switch, and the owner actions.
import { ccc } from '@ckb-ccc/core';
import {
  RpcClient, buildCancel, buildReclaim, buildRenew, buildRewrap, liveJobCells, readSwitch, type Descriptor, type SwitchStatus,
} from '@crt/client';
import { el, short } from './dom.ts';
import { getDeployment } from './deployments.ts';
import { ctxOf, download, kitFileName, loadRunnerRows, requireWallet } from './flow.ts';
import { parseKit } from './kitfile.ts';
import { makeClient } from './networks.ts';
import { session } from './session.ts';
import { addSwitchByT, forgetSwitch, listSwitches, storedKit, type LocalSwitch } from './switches.ts';

const err = (e: unknown) => (e instanceof Error ? e.message : String(e));
const BLOCK_SECONDS = 10.8;

export function formatDuration(sec: number): string {
  const s = Math.abs(Math.round(sec));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Countdown to the deadline in chain median time (not the local clock). */
export function countdown(deadline: number, medianSeconds: number): string {
  const left = deadline - medianSeconds;
  return left > 0 ? `${formatDuration(left)} left` : `deadline passed ${formatDuration(left)} ago`;
}

export interface Live { status: SwitchStatus; median: number; ages: Map<string, number | null>; descriptor: Descriptor | null }

/** Median time of the chain in unix seconds (`get_blockchain_info`). */
export async function medianTime(rpc: RpcClient): Promise<number> {
  const info = await rpc.call<{ median_time: string }>('get_blockchain_info');
  return Math.floor(Number(BigInt(info.median_time)) / 1000);
}

async function loadLive(s: LocalSwitch): Promise<Live> {
  const deployment = getDeployment(session.network);
  const ctx = ctxOf(deployment);
  const html = storedKit(s.T);
  let descriptor: Descriptor | null = null;
  if (html) { try { descriptor = parseKit(html).descriptor; } catch { descriptor = null; } }
  const [median, first] = await Promise.all([medianTime(ctx.rpc), readSwitch(s.T, ctx)]);
  // Last heartbeat = the block time of the live heartbeat job cell of each runner (it is recreated on every run).
  const ages = new Map<string, number | null>();
  const client = makeClient(session.network);
  try {
    const jobs = await liveJobCells(s.T, first.nodeCells.map((n) => n.R), { signer: { client } as unknown as ccc.Signer, deployment });
    for (const j of jobs) {
      if (j.job.trigger.kind !== 'Every') continue;
      const h = await client.getTransactionWithHeader(j.cell.outPoint.txHash);
      const ts = h?.header ? Math.floor(Number(h.header.timestamp) / 1000) : null;
      ages.set(j.R.toLowerCase(), ts === null ? null : Math.max(0, median - ts));
    }
  } catch { /* heartbeat ages stay unknown */ }
  const hb = (s.params.heartbeatBlocks as number | undefined) ?? 8000;
  const fresh = (R: string) => { const a = ages.get(R.toLowerCase()); return a === undefined || a === null || a < 3 * hb * BLOCK_SECONDS; };
  const status = descriptor ? await readSwitch(s.T, ctx, { descriptor: descriptor as never, heartbeatFresh: fresh }) : first;
  return { status, median, ages, descriptor };
}

function headroomText(l: Live): string {
  const h = l.status.headroom;
  if (!h) return 'headroom unknown (load the kit with "Download kit again" first, or this switch was added by T only)';
  return `threshold headroom ${h.threshold}${h.mandatory !== null ? `, mandatory headroom ${h.mandatory}` : ''}`;
}

async function send(build: () => Promise<ccc.Transaction>, msg: HTMLElement, what: string): Promise<boolean> {
  try {
    const signer = requireWallet();
    msg.className = ''; msg.textContent = `Building ${what}…`;
    const tx = await build();
    msg.textContent = 'Waiting for your wallet to sign…';
    const hash = await signer.sendTransaction(tx);
    msg.textContent = `${what} sent: ${hash}`;
    return true;
  } catch (e) { msg.className = 'err'; msg.textContent = err(e); return false; }
}

function switchCard(s: LocalSwitch, rerender: () => void): HTMLElement {
  const card = el('section', { class: 'panel switch', 'data-T': s.T }, el('h3', {}, `Switch ${short(s.T)}`));
  const info = el('div', { 'aria-live': 'polite' }, el('p', { class: 'muted' }, 'Loading from the chain…'));
  const msg = el('p', { role: 'status', 'aria-live': 'polite' });
  const panel = el('div');
  let live: Live | null = null;
  const ctxFor = () => ({ signer: requireWallet(), deployment: getDeployment(session.network) });

  // Cancel: one click opens the confirmation, one click confirms. Same size as Create (primary button), never smaller.
  const cancel = el('button', { type: 'button', class: 'primary cancel-btn', id: `cancel-${s.T.slice(2, 10)}` }, 'Cancel');
  cancel.addEventListener('click', () => {
    const yes = el('button', { type: 'button', class: 'primary cancel-btn', 'data-action': 'confirm-cancel' }, 'Yes, cancel this switch');
    const no = el('button', { type: 'button', class: 'primary', 'data-action': 'keep' }, 'Keep it');
    no.addEventListener('click', () => panel.replaceChildren());
    yes.addEventListener('click', async () => {
      yes.disabled = true;
      if (await send(() => buildCancel(s.T, { reclaimNodeCells: true }, ctxFor()), msg, 'Cancel')) panel.replaceChildren();
      else yes.disabled = false;
    });
    panel.replaceChildren(el('div', { class: 'note', role: 'alertdialog', 'aria-label': 'Confirm cancel' },
      el('p', {}, 'Cancelling consumes the Alive Cell. The secret can then never be released by this switch. This cannot be undone.'), el('div', { class: 'row' }, yes, no)));
    yes.focus();
  });

  const renew = el('button', { type: 'button', 'data-action': 'renew' }, 'Renew');
  renew.addEventListener('click', () => {
    const date = el('input', { type: 'date', id: 'renew-date' });
    const go = el('button', { type: 'button', class: 'primary' }, 'Sign Renew');
    go.addEventListener('click', async () => {
      const t = Date.parse(`${date.value}T00:00:00Z`);
      if (!Number.isFinite(t)) { msg.className = 'err'; msg.textContent = 'Pick the new deadline.'; return; }
      if (live && t / 1000 <= Number(live.status.deadline ?? 0n)) { msg.className = 'err'; msg.textContent = 'Renew moves the deadline later; pick a date after the current one.'; return; }
      if (await send(async () => buildRenew(s.T, BigInt(Math.floor(t / 1000)), undefined, ctxFor()), msg, 'Renew')) panel.replaceChildren();
    });
    panel.replaceChildren(el('div', { class: 'field' }, el('label', { for: 'renew-date' }, 'New deadline (UTC date)'), date, go));
  });

  const rewrap = el('button', { type: 'button', 'data-action': 'rewrap' }, 'Rewrap');
  rewrap.addEventListener('click', async () => {
    panel.replaceChildren(el('p', { class: 'muted' }, 'Loading runners…'));
    try {
      const rows = await loadRunnerRows();
      const cur = new Set((live?.status.nodeCells ?? []).map((n) => n.R.toLowerCase()));
      const drops: string[] = [], adds: string[] = [];
      const list = el('ul', { class: 'plain' });
      for (const n of live?.status.nodeCells ?? []) {
        const cb = el('input', { type: 'checkbox', id: `drop-${n.R.slice(2, 10)}` });
        cb.addEventListener('change', () => { if (cb.checked) drops.push(n.R); else drops.splice(drops.indexOf(n.R), 1); });
        list.append(el('li', {}, cb, ` drop ${short(n.R)}`));
      }
      for (const r of rows.filter((x) => !cur.has(x.runner.R.toLowerCase()))) {
        const cb = el('input', { type: 'checkbox', id: `add-${r.runner.R.slice(2, 10)}` });
        cb.addEventListener('change', () => { if (cb.checked) adds.push(r.runner.R); else adds.splice(adds.indexOf(r.runner.R), 1); });
        list.append(el('li', {}, cb, ` add ${r.runner.label ?? short(r.runner.R)}`));
      }
      const go = el('button', { type: 'button', class: 'primary' }, 'Sign Rewrap');
      go.addEventListener('click', async () => {
        const add = rows.filter((r) => adds.includes(r.runner.R)).map((r) => ({ R: r.runner.R, servicePubkey: r.runner.servicePubkey }));
        if (await send(() => buildRewrap(s.T, drops, add, ctxFor()), msg, 'Rewrap')) panel.replaceChildren(el('p', { class: 'note' }, 'After the new runners commit, arm again: a new descriptor and a new kit are needed.'));
      });
      panel.replaceChildren(el('p', {}, 'Choose runners to drop and runners to add. The new runners start unarmed; a new Arm and a new kit follow once they commit.'), list, go);
    } catch (e) { panel.replaceChildren(el('p', { class: 'err', role: 'alert' }, err(e))); }
  });

  const reclaim = el('button', { type: 'button', 'data-action': 'reclaim' }, 'Reclaim');
  reclaim.addEventListener('click', () => void send(() => buildReclaim(s.T, ctxFor()), msg, 'Reclaim'));

  const kit = el('button', { type: 'button', 'data-action': 'kit' }, 'Download kit again');
  kit.addEventListener('click', () => {
    const html = storedKit(s.T);
    if (html) download(kitFileName(s.T), html);
    else { msg.className = 'err'; msg.textContent = 'This browser does not hold a kit for this switch (it was created elsewhere). Use the file you saved.'; }
  });

  const forget = el('button', { type: 'button', 'data-action': 'forget' }, 'Remove from list');
  forget.addEventListener('click', () => { forgetSwitch(s.T); rerender(); });

  card.append(info, el('div', { class: 'row actions' }, cancel, renew, rewrap, reclaim, kit, forget), panel, msg);

  loadLive(s).then((l) => {
    live = l;
    const st = l.status;
    const dl = st.deadline !== null ? Number(st.deadline) : s.deadline;
    const rows = st.nodeCells.map((n) => {
      const age = l.ages.get(n.R.toLowerCase());
      const label = s.nodes.find((x) => x.R.toLowerCase() === n.R.toLowerCase())?.label || l.descriptor?.nodes.find((x) => x.runner_lock_hash.toLowerCase() === n.R.toLowerCase())?.label || short(n.R);
      return el('tr', {}, el('td', {}, label), el('td', {}, ['unarmed', 'armed', 'released'][n.data.state] ?? String(n.data.state)), el('td', {}, age === undefined || age === null ? 'unknown' : `${formatDuration(age)} ago`));
    });
    info.replaceChildren(
      el('p', {}, el('strong', {}, `State: ${st.state}. `), dl ? `Deadline ${new Date(dl * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC — ${countdown(dl, l.median)}.` : 'Deadline unknown.'),
      el('p', {}, `${st.armed} of ${st.nodeCells.length} runners armed; ${headroomText(l)}.`),
      el('div', { class: 'scroll' }, el('table', { class: 'runners' }, el('tr', {}, el('th', {}, 'Runner'), el('th', {}, 'State'), el('th', {}, 'Last heartbeat')), ...rows)));
  }).catch((e) => info.replaceChildren(el('p', { class: 'err', role: 'alert' }, err(e))));
  return card;
}

export function renderManage(host: HTMLElement): void {
  host.append(el('h2', {}, 'My switches'));
  if (!session.wallet) host.append(el('p', { class: 'note', id: 'need-wallet' }, 'Connect a wallet to renew, rewrap, cancel or reclaim. Reading works without one.'));
  const list = el('div', { id: 'switch-list' });
  const draw = () => {
    list.replaceChildren();
    const mine = listSwitches().filter((s) => s.network === session.network);
    if (mine.length === 0) list.append(el('p', { class: 'muted' }, 'No switches in this browser yet. Create one, or add one by its id T below.'));
    for (const s of mine) list.append(switchCard(s, draw));
  };
  const tIn = el('input', { type: 'text', id: 'add-t', autocomplete: 'off', size: '70', placeholder: '0x… (T)' });
  const add = el('button', { type: 'button', id: 'add-by-t' }, 'Add by T');
  const addMsg = el('p', { class: 'err', role: 'alert' });
  add.addEventListener('click', () => {
    try { addSwitchByT(session.network, tIn.value); tIn.value = ''; addMsg.textContent = ''; draw(); } catch (e) { addMsg.textContent = err(e); }
  });
  host.append(list, el('section', { class: 'panel' }, el('div', { class: 'field' }, el('label', { for: 'add-t' }, 'Add a switch by T'), tIn), add, addMsg));
  draw();
}
