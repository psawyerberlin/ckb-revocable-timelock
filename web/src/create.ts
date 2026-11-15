// The create flow: Deadline → Runners → Quote → Create → Arm → Kit. Each screen is one hash route.
import {
  SWITCH_PARAM_RANGES, selectRunners, type Runner,
} from '@crt/client';
import { el, short } from './dom.ts';
import { getDeployment } from './deployments.ts';
import { ckbToShannons, getDraft, resetDraft, saveDraft, shannonsToCkb, type Draft } from './draft.ts';
import { coalitionSummary } from './coalition.ts';
import {
  Mismatch, createSwitch, download, kitFileName, loadRunnerRows, makeKit, parseSecretHex, randomSecret, readCreated,
  sendArm, verifyAndDescribe, type RunnerRow, type VerifiedArm,
} from './flow.ts';
import { computeQuote, fmt } from './quote.ts';
import { QUANTUM_DISCLAIMER, YEAR_SECONDS, durationRisk, suggestedStructure } from './risk.ts';
import { clearKit, loadKit, memory, saveKit } from './secrets.ts';
import { session } from './session.ts';
import { rememberSwitch, storeKit } from './switches.ts';
import { bytesToHex as hex } from '@crt/client';

export const STEPS = ['deadline', 'runners', 'quote', 'create', 'arm', 'kit'] as const;
export type Step = (typeof STEPS)[number];
const TITLES: Record<Step, string> = { deadline: 'Deadline', runners: 'Runners', quote: 'Quote', create: 'Create', arm: 'Arm', kit: 'Kit' };
export const OPERATORS_URL = 'https://github.com/psawyerberlin/ckb-revocable-timelock/blob/main/docs/operators.md';
const R = SWITCH_PARAM_RANGES;

const err = (e: unknown) => (e instanceof Error ? e.message : String(e));
const href = (s: Step) => `#/create/${s}`;

function stepper(current: Step): HTMLElement {
  const ol = el('ol', { class: 'steps', 'aria-label': 'Create a switch' });
  STEPS.forEach((s, i) => {
    const li = el('li', {}, s === current ? el('strong', { 'aria-current': 'step' }, `${i + 1}. ${TITLES[s]}`) : `${i + 1}. ${TITLES[s]}`);
    ol.append(li);
  });
  return ol;
}

function nav(prev: Step | null, next: { step: Step; enabled: boolean; label?: string } | null): HTMLElement {
  const row = el('div', { class: 'row nav-row' });
  if (prev) row.append(el('a', { href: href(prev), class: 'btn', id: 'back' }, 'Back'));
  if (next) {
    if (next.enabled) row.append(el('a', { href: href(next.step), class: 'btn primary', id: 'next' }, next.label ?? 'Next'));
    else row.append(el('button', { type: 'button', class: 'primary', id: 'next', disabled: '' }, next.label ?? 'Next'));
  }
  return row;
}

const field = (label: string, input: HTMLElement, hint?: string) =>
  el('div', { class: 'field' }, el('label', { for: input.id }, label), input, ...(hint ? [el('p', { class: 'muted hint' }, hint)] : []));

function needWallet(): HTMLElement | null {
  return session.wallet ? null : el('p', { class: 'note', id: 'need-wallet' }, 'Connect a wallet above to continue.');
}

// ---- 1. Deadline ------------------------------------------------------------------------------------------------

function deadlineScreen(host: HTMLElement, d: Draft): void {
  const input = el('input', { type: 'date', id: 'deadline', required: '' });
  const tomorrow = new Date(Date.now() + 86_400_000 + 86_400_000);
  input.min = tomorrow.toISOString().slice(0, 10);
  if (d.deadline !== null) input.value = new Date(d.deadline * 1000).toISOString().slice(0, 10);
  const risk = el('div', { id: 'risk', 'aria-live': 'polite' });
  const next = el('div');
  const paint = () => {
    const term = d.deadline === null ? null : d.deadline - Math.floor(Date.now() / 1000);
    risk.replaceChildren();
    if (term === null) risk.append(el('p', { class: 'muted' }, 'Pick the date at which the secret is released if nobody postpones or cancels.'));
    else {
      const r = durationRisk(term);
      const years = (term / YEAR_SECONDS).toFixed(1);
      risk.append(el('p', {}, el('strong', {}, `Term: ${Math.max(0, Math.round(term / 86_400))} days (${years} years). `), r.text), el('p', {}, r.recommendation));
      if (r.quantum) risk.append(el('p', { class: 'note', id: 'quantum', role: 'note' }, QUANTUM_DISCLAIMER));
    }
    next.replaceChildren(nav(null, { step: 'runners', enabled: term !== null && term >= 86_400 }));
  };
  input.addEventListener('input', () => {
    const t = Date.parse(`${input.value}T00:00:00Z`);
    d.deadline = Number.isFinite(t) ? Math.floor(t / 1000) : null;
    if (d.deadline !== null) {
      const s = suggestedStructure(d.deadline - Math.floor(Date.now() / 1000));
      d.n = s.n; d.t = s.t; d.selected = []; d.mandatory = [];
    }
    saveDraft(d); paint();
  });
  host.append(
    el('h2', {}, 'Deadline'),
    el('p', {}, 'At the deadline the secret is released to whoever holds the recovery kit, unless you postponed or cancelled before. The deadline is a date in UTC; the term must be at least one day.'),
    field('Release date', input), risk, next,
  );
  paint();
}

// ---- 2. Runners -------------------------------------------------------------------------------------------------

let rowsCache: { network: string; rows: RunnerRow[] } | null = null;

function runnersScreen(host: HTMLElement, d: Draft): void {
  if (d.deadline === null) { host.append(el('p', {}, 'Choose a deadline first. '), el('a', { href: href('deadline') }, 'Go to Deadline')); return; }
  const term = d.deadline - Math.floor(Date.now() / 1000);
  const body = el('div');
  const status = el('p', { class: 'muted', role: 'status' }, 'Loading the runner directory…');
  host.append(el('h2', {}, 'Runners'), el('p', {}, 'Choose how many runners hold your key (n) and how many of them must release it (t).'), status, body);

  const paint = (rows: RunnerRow[]) => {
    const byR = new Map(rows.map((r) => [r.runner.R, r]));
    const chosen = () => d.selected.map((r) => byR.get(r)?.runner).filter((r): r is Runner => r !== undefined);
    const nIn = el('input', { type: 'number', id: 'n', min: String(R.n.min), max: String(R.n.max), value: String(d.n) });
    const tIn = el('input', { type: 'number', id: 't', min: '1', max: String(d.n), value: String(d.t) });
    const jIn = el('input', { type: 'number', id: 'j', min: '1', value: String(d.mandatoryJ) });
    const ackIn = el('input', { type: 'text', id: 'ack', autocomplete: 'off', value: d.ack });
    const summary = el('div', { id: 'coalition', 'aria-live': 'polite' });
    const trade = el('div');
    const nextBox = el('div');
    const table = el('table', { class: 'runners' });

    const oneOfOne = () => d.mandatory.filter((r) => d.selected.includes(r)).length === 1 && term > R.oneOfOneMandatoryTermSeconds;
    const refresh = () => {
      const ch = chosen();
      const cs = coalitionSummary(ch);
      summary.replaceChildren(el('h3', {}, 'Coalition risk of this selection'), el('p', {}, cs.text));
      const m = d.mandatory.filter((r) => d.selected.includes(r));
      trade.replaceChildren();
      if (m.length > 0) {
        trade.append(el('p', { class: 'note' }, 'Every mandatory node makes the secret harder to steal and easier to lose, one for one.'));
        if (m.length > 1) trade.append(field(`Mandatory nodes needed (j of ${m.length})`, jIn));
        if (oneOfOne()) trade.append(el('p', { class: 'note', id: 'one-of-one' }, 'A single mandatory runner on a term over one year: if that runner is lost, the secret is lost. Type "I understand" to accept this.'), field('Type: I understand', ackIn));
      }
      const tOk = Number.isInteger(d.t) && d.t >= 1 && d.t <= d.n;
      const ready = d.selected.length === d.n && tOk && d.n >= R.n.min && d.n <= R.n.max && (!oneOfOne() || d.ack.trim() === 'I understand')
        && (m.length < 2 || (d.mandatoryJ >= 1 && d.mandatoryJ <= m.length));
      nextBox.replaceChildren(
        el('p', { class: 'muted', id: 'sel-count' }, `${d.selected.length} of ${d.n} runners selected.` + (d.n < R.n.warnBelow ? ' Warning: fewer than 5 runners means little redundancy or little protection.' : '')),
        nav('deadline', { step: 'quote', enabled: ready }),
      );
      tbody.querySelectorAll<HTMLInputElement>('input.pick').forEach((c) => { c.checked = d.selected.includes(c.value); c.disabled = !c.checked && d.selected.length >= d.n; });
      tbody.querySelectorAll<HTMLInputElement>('input.mand').forEach((c) => { c.checked = d.mandatory.includes(c.value); c.disabled = !d.selected.includes(c.value); });
    };
    const commit = () => { saveDraft(d); refresh(); };

    nIn.addEventListener('input', () => {
      const v = Number(nIn.value);
      if (Number.isInteger(v)) { d.n = v; tIn.max = String(v); d.selected = d.selected.slice(0, Math.max(v, 0)); d.mandatory = d.mandatory.filter((r) => d.selected.includes(r)); }
      commit();
    });
    tIn.addEventListener('input', () => { d.t = Number(tIn.value); commit(); });
    jIn.addEventListener('input', () => { d.mandatoryJ = Number(jIn.value); commit(); });
    ackIn.addEventListener('input', () => { d.ack = ackIn.value; commit(); });

    const thead = el('thead', {}, el('tr', {}, ...['Runner', 'Mandatory', 'Rank', 'Availability (30 d)', 'Country / ASN', 'Stake', 'Status', 'Switches served'].map((h) => el('th', { scope: 'col' }, h))));
    const tbody = el('tbody');
    const sorted = [...rows].sort((a, b) => (a.runner.monitor?.rank ?? Infinity) - (b.runner.monitor?.rank ?? Infinity));
    for (const { runner: r, switchesServed } of sorted) {
      const pick = el('input', { type: 'checkbox', class: 'pick', value: r.R, 'aria-label': `Select runner ${r.label ?? short(r.R)}` });
      pick.addEventListener('change', () => {
        d.selected = pick.checked ? [...d.selected, r.R] : d.selected.filter((x) => x !== r.R);
        if (!pick.checked) d.mandatory = d.mandatory.filter((x) => x !== r.R);
        commit();
      });
      const mand = el('input', { type: 'checkbox', class: 'mand', value: r.R, 'aria-label': `Mark ${r.label ?? short(r.R)} as mandatory` });
      mand.addEventListener('change', () => {
        d.mandatory = mand.checked ? [...d.mandatory, r.R] : d.mandatory.filter((x) => x !== r.R);
        d.mandatoryJ = Math.min(d.mandatoryJ, Math.max(1, d.mandatory.length));
        commit();
      });
      const avail = r.monitor?.availability.d30;
      const status = el('td', {}, r.monitor ? `${r.monitor.checkType}, ${r.monitor.stakeStatus}` : 'no monitor data');
      if (r.unproven) status.append(' ', el('span', { class: 'badge', title: 'Announced CRT, no observed performance yet' }, 'unproven'));
      tbody.append(el('tr', {},
        el('td', {}, pick, ' ', el('span', {}, r.label ?? short(r.R))), el('td', {}, mand),
        el('td', {}, r.monitor?.rank != null ? String(r.monitor.rank) : '—'),
        el('td', {}, avail != null ? `${(avail * (avail <= 1 ? 100 : 1)).toFixed(1)} %` : '—'),
        el('td', {}, r.diversityKey ? r.diversityKey.replace('/', ' / ') : 'unknown'),
        el('td', {}, r.monitor?.stakeStatus ?? 'unknown'),
        status, el('td', {}, switchesServed === null ? '—' : String(switchesServed)),
      ));
    }
    table.append(thead, tbody);
    if (rows.length === 0) body.append(el('p', { class: 'note' }, 'No runners found on this network.'));

    const auto = el('button', { type: 'button', id: 'auto' }, 'Pick for me');
    auto.addEventListener('click', () => {
      try {
        const keep = d.mandatory.filter((x) => byR.has(x));
        const sel = selectRunners(rows.map((x) => x.runner), { n: d.n, mandatory: keep, requireDepositedValid: false });
        d.selected = sel.map((x) => x.R); d.mandatory = keep;
        status.textContent = '';
      } catch (e) { status.textContent = err(e); }
      commit();
    });
    body.replaceChildren(
      el('div', { class: 'row' }, field('Runners (n)', nIn), field('Needed to release (t)', tIn), auto),
      el('p', { class: 'muted' }, 'Runners are ranked by the CSR Network Monitor. “Unproven” runners announced CRT but have no observed performance yet; they are not penalised.'),
      el('div', { class: 'scroll' }, table), summary, trade,
      el('p', {}, el('a', { href: OPERATORS_URL, id: 'run-your-own', rel: 'noopener' }, 'Run your own runner'), ' and mark it mandatory: the strongest early protection comes from a runner you control.'),
      nextBox,
    );
    refresh();
  };

  const run = async () => {
    try {
      getDeployment(session.network);
    } catch (e) { status.textContent = err(e); status.className = 'err'; return; }
    try {
      if (!rowsCache || rowsCache.network !== session.network) rowsCache = { network: session.network, rows: await loadRunnerRows() };
      status.textContent = '';
      paint(rowsCache.rows);
    } catch (e) {
      status.textContent = `Could not load the runner directory: ${err(e)}`; status.className = 'err';
      const retry = el('button', { type: 'button' }, 'Retry');
      retry.addEventListener('click', () => { host.replaceChildren(); runnersScreen(host, d); });
      body.replaceChildren(retry);
    }
  };
  void run();
}

export function chosenRunners(d: Draft): Runner[] {
  const byR = new Map((rowsCache?.rows ?? []).map((r) => [r.runner.R, r.runner]));
  return d.selected.map((r) => byR.get(r)).filter((r): r is Runner => r !== undefined);
}

// ---- 3. Quote ---------------------------------------------------------------------------------------------------

function quoteScreen(host: HTMLElement, d: Draft): void {
  if (d.deadline === null || d.selected.length !== d.n) { host.append(el('p', {}, 'Choose a deadline and runners first. '), el('a', { href: href('runners') }, 'Go to Runners')); return; }
  let deployment: { block_seconds?: number } | null = null;
  try { deployment = getDeployment(session.network); } catch { /* the quote still works with defaults */ }
  const out = el('div', { id: 'quote' });
  const nextBox = el('div');

  const slider = el('input', { type: 'range', id: 'heartbeat', min: String(R.heartbeatBlocks.min), max: String(R.heartbeatBlocks.max), step: '500', value: String(d.heartbeatBlocks) });
  const num = (id: string, value: string) => el('input', { type: 'text', inputmode: 'decimal', id, value });
  const hbTip = num('heartbeat-tip', shannonsToCkb(d.heartbeatTip));
  const kgTip = num('keygen-tip', shannonsToCkb(d.keygenTip));
  const maxFee = num('max-fee', shannonsToCkb(d.maxFee));
  const orgFee = num('organiser-fee', shannonsToCkb(d.organiserFee));
  const errs = el('p', { class: 'err', role: 'alert', id: 'param-errors' });
  const hbOut = el('output', { for: 'heartbeat', id: 'heartbeat-out' });

  const paint = () => {
    const q = computeQuote(d, deployment);
    hbOut.textContent = `${d.heartbeatBlocks} blocks (about ${(d.heartbeatBlocks * (deployment?.block_seconds ?? 10.8) / 86_400).toFixed(2)} days)`;
    out.replaceChildren();
    if (!q) { out.append(el('p', { class: 'err' }, 'The term is shorter than one day.')); return; }
    const lines = el('table', { class: 'quote' }, el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, 'Item'), el('th', { scope: 'col', class: 'num' }, 'CKB'), el('th', { scope: 'col' }, 'Kind'))));
    const body = el('tbody');
    for (const l of q.lines) {
      body.append(el('tr', { id: `line-${l.id}` }, el('td', {}, l.label), el('td', { class: 'num' }, fmt(l.ckb)), el('td', {}, l.group === 'spent' ? 'spent' : 'locked, refundable')));
    }
    lines.append(body);
    out.append(
      el('div', { class: 'row totals' },
        el('p', {}, el('span', { class: 'muted' }, 'Spent '), el('strong', { id: 'spent' }, `${fmt(q.spentOverTerm)} CKB`), ' over the term, of which ', el('span', { id: 'spent-now' }, `${fmt(q.spentNow)} CKB`), ' now'),
        el('p', {}, el('span', { class: 'muted' }, 'Locked '), el('strong', { id: 'locked' }, `${fmt(q.parked)} CKB`), ` (refundable; plus ${fmt(q.parkedTransient)} CKB for a few hours during key generation)`)),
      lines,
      el('p', {}, `Running cost ≈ ${fmt(q.monthly)} CKB per month. ${q.runs} heartbeat runs. A silent runner is noticed after about ${(q.detectionDelaySeconds / 86_400).toFixed(1)} days.`),
      el('details', {}, el('summary', {}, 'Assumptions'), el('ul', {}, ...q.assumptions.map((a) => el('li', {}, a)))),
    );
  };
  const read = () => {
    const e: string[] = [];
    const set = (key: 'heartbeatTip' | 'keygenTip' | 'maxFee' | 'organiserFee', input: HTMLInputElement, min: bigint, what: string) => {
      const v = ckbToShannons(input.value);
      if (v === null) e.push(`${what}: not a number`);
      else if (v < min) e.push(`${what}: below the minimum ${shannonsToCkb(min)} CKB`);
      else d[key] = v.toString();
    };
    d.heartbeatBlocks = Number(slider.value);
    set('heartbeatTip', hbTip, R.heartbeatTip.min, 'Heartbeat tip');
    set('keygenTip', kgTip, R.keygenTip.min, 'Keygen tip');
    set('maxFee', maxFee, R.maxFee.min, 'Max fee');
    set('organiserFee', orgFee, R.organiserFee.min, 'Organiser fee');
    errs.textContent = e.join(' ');
    saveDraft(d); paint();
    nextBox.replaceChildren(nav('runners', { step: 'create', enabled: e.length === 0 && computeQuote(d, deployment) !== null }));
  };
  for (const i of [slider, hbTip, kgTip, maxFee, orgFee]) i.addEventListener('input', read);

  const noOrg = el('button', { type: 'button', id: 'no-organiser' }, 'Set organiser fee to 0');
  noOrg.addEventListener('click', () => { orgFee.value = '0'; read(); });

  host.append(
    el('h2', {}, 'Quote'),
    el('p', {}, 'What this switch costs, computed from the parameters below. “Spent” is gone; “locked” comes back when you cancel or reclaim.'),
    el('div', { class: 'panel' },
      field('Heartbeat interval', slider, 'Shorter intervals notice a missing runner sooner but cost more.'), hbOut,
      field('Heartbeat tip (CKB per run)', hbTip), field('Keygen tip (CKB per runner)', kgTip), field('Max fee (CKB per run)', maxFee),
      field('Organiser fee (CKB)', orgFee, 'Optional, paid to whoever runs this app. You can set it to 0.'), noOrg, errs),
    out, nextBox,
  );
  read();
}

// ---- 4. Create --------------------------------------------------------------------------------------------------

let pollToken = 0;
export const stopPolling = (): void => { pollToken++; };

function createScreen(host: HTMLElement, d: Draft): void {
  if (d.deadline === null || d.selected.length !== d.n) { host.append(el('p', {}, 'Choose a deadline and runners first. '), el('a', { href: href('deadline') }, 'Start over')); return; }
  const status = el('p', { role: 'status', id: 'create-status' });
  const progress = el('div', { id: 'progress' });
  const nextBox = el('div');
  const q = computeQuote(d, null);
  host.append(el('h2', {}, 'Create'), el('p', {}, 'One transaction creates the Alive Cell, a Node Cell per runner and their keygen jobs. Nothing else is needed from you until the runners have committed their keys.'));

  const paintProgress = async () => {
    const token = ++pollToken;
    const c = d.created!;
    host.querySelector('#created')?.remove();
    host.append(el('div', { id: 'created', class: 'panel' }, el('p', {}, 'Switch identifier ', el('strong', {}, 'T'), ': ', el('span', { class: 'addr', id: 'T' }, c.T)), el('p', { class: 'muted' }, 'Transaction ', el('span', { class: 'addr' }, c.txHash)), progress, nextBox));
    const tick = async () => {
      if (token !== pollToken) return;
      let committed = 0;
      try {
        const s = await readCreated(c);
        const byR = new Map(s.nodeCells.map((n) => [n.R.toLowerCase(), n.data.state]));
        const ul = el('ul', { class: 'progress-list' });
        for (const n of c.nodes) {
          const st = byR.get(n.R.toLowerCase());
          if (st !== undefined && st >= 1) committed++;
          ul.append(el('li', { 'data-state': st === undefined ? 'unconfirmed' : st >= 1 ? 'committed' : 'waiting' }, `${n.label || short(n.R)}: ${st === undefined ? 'waiting for the Create transaction to confirm' : st >= 1 ? 'committed ✓' : 'waiting for the runner to commit its key'}`));
        }
        progress.replaceChildren(el('p', {}, el('strong', { id: 'committed' }, `${committed} of ${c.nodes.length} runners committed`)), ul);
      } catch (e) { progress.prepend(el('p', { class: 'err' }, `Could not read the chain: ${err(e)}`)); }
      nextBox.replaceChildren(nav(null, { step: 'arm', enabled: committed === c.nodes.length, label: 'Continue to Arm' }));
      if (committed < c.nodes.length) setTimeout(() => void tick(), 6000);
    };
    void tick();
  };

  if (d.created) { void paintProgress(); return; }
  const dis = needWallet();
  const btn = el('button', { type: 'button', class: 'primary', id: 'create' }, 'Sign and create');
  btn.disabled = !session.wallet;
  btn.addEventListener('click', async () => {
    btn.disabled = true; status.textContent = 'Waiting for the wallet and the network…'; status.className = '';
    try {
      d.created = await createSwitch(d, chosenRunners(d));
      saveDraft(d);
      rememberSwitch(session.network, d.created);
      status.textContent = 'Create sent.';
      btn.remove();
      void paintProgress();
    } catch (e) { status.textContent = err(e); status.className = 'err'; btn.disabled = false; }
  });
  host.append(...(dis ? [dis] : []), ...(q ? [el('p', {}, `You will lock about ${fmt(q.parked)} CKB and spend about ${fmt(q.spentOverTerm)} CKB over the term.`)] : []), el('div', { class: 'row' }, el('a', { href: href('quote'), class: 'btn' }, 'Back'), btn), status);
}

// ---- 5. Arm -----------------------------------------------------------------------------------------------------

function armScreen(host: HTMLElement, d: Draft): void {
  const c = d.created;
  if (!c) { host.append(el('p', {}, 'Create the switch first. '), el('a', { href: href('create') }, 'Go to Create')); return; }
  const out = el('div', { id: 'arm-out', 'aria-live': 'polite' });
  host.append(el('h2', {}, 'Arm'), el('p', {}, 'The app now checks every runner against the chain (hard fail: there is no way around a failed check), builds the descriptor, and asks you to sign Arm.'), out);
  if (d.armTx) { out.append(el('p', { id: 'armed' }, `Arm sent: ${d.armTx}`), nav(null, { step: 'kit', enabled: true, label: 'Continue to Kit' })); return; }

  const own = el('input', { type: 'text', id: 'own-secret', autocomplete: 'off', spellcheck: 'false', placeholder: 'optional: 64 hex characters' });
  const go = el('button', { type: 'button', class: 'primary', id: 'verify' }, 'Verify and build descriptor');
  out.append(field('Your own 32-byte secret (hex), or leave empty to generate one', own), go);
  go.addEventListener('click', async () => {
    const K = own.value.trim() ? parseSecretHex(own.value) : randomSecret();
    if (!K) { out.append(el('p', { class: 'err', role: 'alert' }, 'The secret must be exactly 64 hex characters.')); return; }
    go.disabled = true;
    const msg = el('p', { role: 'status' }, 'Verifying the runners on chain…');
    out.append(msg);
    let v: VerifiedArm;
    try { v = await verifyAndDescribe(d, c, K); }
    catch (e) {
      msg.remove();
      if (e instanceof Mismatch) {
        out.replaceChildren(el('div', { class: 'note err', role: 'alert', id: 'mismatch' }, el('strong', {}, `MISMATCH (rule ${e.rule})`), el('p', {}, e.message), el('p', {}, 'Nothing was signed and nothing will be. Do not arm this switch; cancel it and start again.')));
      } else { go.disabled = false; out.append(el('p', { class: 'err', role: 'alert' }, err(e))); }
      return;
    }
    msg.remove();
    memory.K = K; memory.descriptor = v.descriptor; memory.hash = v.hash;
    try { const html = await makeKit(c, v); saveKit(html, kitFileName(c.T)); storeKit(c.T, html); } catch (e) { out.append(el('p', { class: 'err', role: 'alert' }, `Could not build the kit: ${err(e)}`)); return; }
    const sign = el('button', { type: 'button', class: 'primary', id: 'sign-arm' }, 'Sign Arm');
    sign.disabled = !session.wallet;
    const st = el('p', { role: 'status' });
    sign.addEventListener('click', async () => {
      sign.disabled = true; st.textContent = 'Waiting for the wallet…'; st.className = '';
      try { d.armTx = await sendArm(d, c, v); saveDraft(d); rememberSwitch(session.network, c, d.armTx); host.replaceChildren(); armScreen(host, d); }
      catch (e) { st.textContent = err(e); st.className = 'err'; sign.disabled = false; }
    });
    out.replaceChildren(
      el('p', { id: 'verified' }, 'All checks passed. Descriptor hash ', el('span', { class: 'addr' }, v.hash)),
      el('p', {}, 'Your secret (keep it with the kit; it is not stored anywhere):'), el('p', { class: 'addr', id: 'secret' }, hex(K)),
      ...(needWallet() ? [needWallet()!] : []), sign, st,
    );
  });
}

// ---- 6. Kit -----------------------------------------------------------------------------------------------------

function kitScreen(host: HTMLElement, d: Draft): void {
  const c = d.created;
  const kit = loadKit();
  if (!c || !d.armTx || !kit) { host.append(el('p', {}, 'The kit is built when the switch is armed. '), el('a', { href: href('arm') }, 'Go to Arm')); return; }
  const dl = el('button', { type: 'button', class: 'primary', id: 'download-kit' }, `Download ${kit.name}`);
  dl.addEventListener('click', () => download(kit.name, kit.html));
  const saved = el('input', { type: 'checkbox', id: 'kit-saved' });
  saved.checked = d.kitSaved;
  const done = el('div');
  const paint = () => {
    done.replaceChildren(saved.checked
      ? el('a', { href: '#/', class: 'btn primary', id: 'finish' }, 'Finish')
      : el('button', { type: 'button', class: 'primary', id: 'finish', disabled: '' }, 'Finish'));
  };
  saved.addEventListener('change', () => { d.kitSaved = saved.checked; saveDraft(d); paint(); });
  const mirror = el('input', { type: 'checkbox', id: 'mirror', disabled: '' });
  window.onbeforeunload = () => (d.kitSaved ? null : 'You have not saved the kit.');
  const finishLink = done;
  finishLink.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === 'finish' && saved.checked) { window.onbeforeunload = null; memory.K = null; memory.descriptor = null; clearKit(); resetDraft(session.network); }
  });
  host.append(
    el('h2', {}, 'Kit'),
    el('p', {}, 'The recovery kit is one HTML file. After the deadline, whoever holds it can read the released key shares and rebuild the secret, with no server involved. Store copies somewhere safe and apart from the runners.'),
    el('p', { class: 'muted' }, 'Switch ', el('span', { class: 'addr' }, c.T)), dl,
    el('div', { class: 'row' }, saved, el('label', { for: 'kit-saved' }, 'I have saved the kit')),
    el('div', { class: 'row' }, mirror, el('label', { for: 'mirror', class: 'muted' }, 'Mirror to coordinator (not available in v0.1)')),
    done,
  );
  paint();
}

// ---- router -----------------------------------------------------------------------------------------------------

export function renderCreate(host: HTMLElement, step: Step): void {
  stopPolling();
  const d = getDraft(session.network);
  host.replaceChildren(el('section', { class: 'panel', 'aria-labelledby': 'step-h' }, stepper(step)));
  const panel = host.firstElementChild as HTMLElement;
  const inner = el('div', { id: 'screen', 'data-step': step });
  panel.append(inner);
  const fn = { deadline: deadlineScreen, runners: runnersScreen, quote: quoteScreen, create: createScreen, arm: armScreen, kit: kitScreen }[step];
  fn(inner, d);
  inner.querySelector('h2')?.setAttribute('id', 'step-h');
}
