import {
  MAINNET_DISABLED_TEXT, isNetworkAvailable, type NetworkName,
} from './networks.ts';
import { el } from './dom.ts';
import { updateSession } from './session.ts';
import { connect, formatCkb, listWallets, type WalletInfo, type WalletOption } from './wallet.ts';

const NETWORK_KEY = 'crt.network';

/** Renders the shell and returns the element the router draws the current screen into. */
export function renderShell(root: HTMLElement): HTMLElement {
  const routeHost = el('div', { id: 'route' });
  let network: NetworkName = localStorage.getItem(NETWORK_KEY) === 'mainnet' && isNetworkAvailable('mainnet') ? 'mainnet' : 'testnet';
  let wallets: WalletOption[] = [];
  let active: WalletOption | undefined;
  let info: WalletInfo | undefined;
  let error = '';
  let busy = false;

  const draw = () => {
    const netSel = el('select', { id: 'network', 'aria-label': 'Network' });
    for (const n of ['testnet', 'mainnet'] as const) {
      const o = el('option', { value: n }, n);
      if (!isNetworkAvailable(n)) o.disabled = true;
      if (n === network) o.selected = true;
      netSel.append(o);
    }
    netSel.addEventListener('change', () => {
      network = netSel.value as NetworkName;
      updateSession({ network });
      localStorage.setItem(NETWORK_KEY, network);
      void disconnect();
    });

    const netRow = el('div', { class: 'row' }, el('label', { for: 'network' }, 'Network'), netSel);
    const mainnetNote = isNetworkAvailable('mainnet')
      ? null
      : el('p', { class: 'note', id: 'mainnet-note' }, MAINNET_DISABLED_TEXT);

    const walletPanel = el('section', { class: 'panel', 'aria-labelledby': 'wallet-h' }, el('h2', { id: 'wallet-h' }, 'Wallet'));
    if (info && active) {
      const dis = el('button', { type: 'button', id: 'disconnect' }, 'Disconnect');
      dis.addEventListener('click', () => void disconnect());
      walletPanel.append(
        el('p', {}, `Connected with ${info.wallet} on ${network}.`),
        el('p', {}, el('span', { class: 'muted' }, 'Address '), el('span', { class: 'addr', id: 'address' }, info.address)),
        el('p', {}, el('span', { class: 'muted' }, 'Balance '), el('strong', { id: 'balance' }, formatCkb(info.balance))),
        dis,
      );
    } else {
      const sel = el('select', { id: 'wallet', 'aria-label': 'Wallet' });
      wallets.forEach((w, i) => sel.append(el('option', { value: String(i) }, w.name)));
      const btn = el('button', { type: 'button', class: 'primary', id: 'connect' }, busy ? 'Connecting…' : 'Connect wallet');
      btn.disabled = busy || wallets.length === 0;
      btn.addEventListener('click', async () => {
        const w = wallets[Number(sel.value)];
        if (!w) return;
        busy = true; error = ''; draw();
        try { info = await connect(w); active = w; updateSession({ wallet: w, info }); }
        catch (e) { error = e instanceof Error ? e.message : String(e); }
        busy = false; draw();
      });
      walletPanel.append(el('div', { class: 'row' }, sel, btn));
      if (wallets.length === 0) walletPanel.append(el('p', { class: 'muted' }, 'No wallet available.'));
    }
    if (error) walletPanel.append(el('p', { class: 'err', role: 'alert' }, error));

    const main = el('main', { id: 'main', class: 'shell-main' }, netRow);
    if (mainnetNote) main.append(mainnetNote);
    main.append(walletPanel, routeHost);
    const header = el('header', { class: 'bar' }, el('h1', {}, 'CRT — revocable timelock'),
      el('nav', { 'aria-label': 'Primary' }, el('a', { href: '#/create/deadline' }, 'Create a switch'), el('a', { href: '/' }, 'Overview'), el('a', { href: '/how-it-works.html' }, 'How it works')));
    const wrap = el('div', { class: 'shell' }, header, main);
    root.replaceChildren(wrap);
  };

  const load = () => {
    try { wallets = listWallets(network); } catch (e) { wallets = []; error = e instanceof Error ? e.message : String(e); }
  };
  const disconnect = async () => {
    try { await active?.signer.disconnect?.(); } catch { /* ignore */ }
    active = undefined; info = undefined; error = ''; updateSession({ wallet: undefined, info: undefined }); load(); draw();
  };

  updateSession({ network });
  load(); draw();
  // EIP-6963 providers announce asynchronously: redraw the picker if no wallet is connected.
  setTimeout(() => { if (!info && !busy) { const before = wallets.length; load(); if (wallets.length !== before) draw(); } }, 600);
  return routeHost;
}
