import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, getByText, getByRole, queryByText } from '@testing-library/dom';

// No wallet or network in tests: the wallet module is replaced by an empty provider list.
vi.mock('../src/wallet.ts', () => ({ listWallets: () => [], connect: async () => { throw new Error('no wallet'); }, readInfo: async () => { throw new Error('no wallet'); }, formatCkb: (v: bigint) => `${v} CKB` }));

import { minRunners, renderCreate, STEPS } from '../src/create.ts';
import { renderManage } from '../src/manage.ts';
import { renderRecover } from '../src/recover.ts';
import { renderShell } from '../src/shell.ts';
import { defaultDraft, saveDraft } from '../src/draft.ts';
import { computeQuote } from '../src/quote.ts';
import { MAINNET_DISABLED_TEXT } from '../src/networks.ts';
import { estimateCost, SWITCH_PARAM_RANGES } from '@crt/client';

const DAY = 86_400;
const T = `0x${'ab'.repeat(32)}`;
const mount = (): HTMLElement => { document.body.innerHTML = '<div id="host"></div>'; return document.getElementById('host') as HTMLElement; };

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); document.body.innerHTML = ''; });

describe('shell', () => {
  it('shows the mainnet-disabled text while deployments/mainnet.json is disabled', () => {
    const root = mount(); renderShell(root);
    expect(getByText(root, MAINNET_DISABLED_TEXT)).toBeTruthy();
    expect(MAINNET_DISABLED_TEXT).toMatch(/testnet until CSR's service runtime opens on mainnet/);
    const mainnet = root.querySelector<HTMLOptionElement>('option[value=mainnet]');
    expect(mainnet?.disabled).toBe(true);
  });
});

describe('create flow screens render', () => {
  it.each(STEPS)('step %s', (step) => {
    const host = mount();
    renderCreate(host, step);
    expect(host.querySelector('[data-step]')?.getAttribute('data-step')).toBe(step);
    expect(host.querySelector('ol.steps')).toBeTruthy();
  });

  it('deadline screen explains the quantum risk for terms over 5 years', () => {
    const d = defaultDraft(); d.deadline = Math.floor(Date.now() / 1000) + 6 * 365 * DAY; saveDraft(d);
    const host = mount(); renderCreate(host, 'deadline');
    expect(host.textContent).toMatch(/quantum/i);
  });
});

describe('runner minimum', () => {
  it('allows 1 runner on testnet and keeps 3 on mainnet', () => {
    expect(minRunners('testnet')).toBe(1);
    expect(minRunners('mainnet')).toBe(3);
  });
});

describe('manage and recover', () => {
  it('renders My switches and Recover', () => {
    const a = mount(); renderManage(a); expect(getByText(a, 'My switches')).toBeTruthy();
    const b = mount(); renderRecover(b); expect(b.textContent).toMatch(/recover/i);
  });

  it('Cancel is reachable in at most 2 clicks from My switches and is as big as Create', () => {
    const host = mount(); renderManage(host);
    fireEvent.input(host.querySelector('#add-t') as HTMLInputElement, { target: { value: T } });
    fireEvent.click(getByText(host, 'Add by T'));                       // not counted: the list is local state
    const cancel = getByRole(host, 'button', { name: 'Cancel' });       // click 1 opens the confirmation
    expect(cancel.className).toContain('primary');
    fireEvent.click(cancel);
    const confirm = getByRole(host, 'button', { name: /Yes, cancel this switch/ }); // click 2 signs
    expect(confirm.className).toContain('primary');
    expect(queryByText(host, 'Keep it')).toBeTruthy();
  });
});

describe('quote panel', () => {
  const quoteDraft = () => {
    const d = defaultDraft();
    d.deadline = Math.floor(Date.now() / 1000) + 365 * DAY + 3600;
    d.selected = Array.from({ length: d.n }, (_, i) => `0x${i.toString(16).padStart(64, '0')}`);
    saveDraft(d);
    return d;
  };
  const num = (host: HTMLElement, id: string) => Number((host.querySelector(`#${id}`)?.textContent ?? '').replace(/[^\d.]/g, '').replace(/^(\d+(?:\.\d+)?).*/, '$1'));

  it('matches estimateCost for the defaults (1 530 spent, 4 440 locked, ±2 %)', () => {
    const d = quoteDraft();
    const q = computeQuote(d, null)!;
    expect(q.spentOverTerm).toBeGreaterThan(1530 * 0.98); expect(q.spentOverTerm).toBeLessThan(1530 * 1.02);
    expect(q.parked).toBeGreaterThan(4440 * 0.98); expect(q.parked).toBeLessThan(4440 * 1.02);
    const direct = estimateCost({ deployment: {}, n: d.n, termSeconds: d.deadline! - Math.floor(Date.now() / 1000), heartbeatBlocks: d.heartbeatBlocks,
      heartbeatTipShannons: BigInt(d.heartbeatTip), keygenTipShannons: BigInt(d.keygenTip), maxFeeShannons: BigInt(d.maxFee), organiserFeeShannons: BigInt(d.organiserFee) });
    expect(q.spentOverTerm).toBeCloseTo(direct.spentOverTerm, 1);
  });

  it('web_cost_panel_live: the rendered quote changes when the heartbeat slider moves', () => {
    quoteDraft();
    const host = mount(); renderCreate(host, 'quote');
    const before = host.querySelector('#spent')?.textContent;
    expect(num(host, 'spent')).toBeGreaterThan(1530 * 0.98);
    expect(num(host, 'locked')).toBeGreaterThan(4440 * 0.98);
    expect(num(host, 'locked')).toBeLessThan(4440 * 1.02);
    const slider = host.querySelector('#heartbeat') as HTMLInputElement;
    fireEvent.input(slider, { target: { value: String(SWITCH_PARAM_RANGES.heartbeatBlocks.min) } });
    expect(host.querySelector('#spent')?.textContent).not.toBe(before);
  });
});
