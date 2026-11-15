import { ccc } from '@ckb-ccc/core';
import { JoyId } from '@ckb-ccc/joy-id';
import { Eip6963 } from '@ckb-ccc/eip6963';
import { makeClient, type NetworkName } from './networks.ts';

export interface WalletOption { id: string; name: string; signer: ccc.Signer }
export interface WalletInfo { address: string; balance: bigint; wallet: string }

/** Signer candidates for a network: JoyID first, then every EIP-6963 browser wallet CCC can drive. */
export function listWallets(network: NetworkName): WalletOption[] {
  const client = makeClient(network);
  const out: WalletOption[] = [];
  const joy = JoyId.getJoyIdSigners(client, 'CRT', `${location.origin}/assets/favicon.svg`);
  for (const s of joy) out.push({ id: `joyid:${s.name}`, name: s.name, signer: s.signer });
  const seen = new Set<string>();
  const eip = new Eip6963.SignerFactory(client);
  eip.subscribeSigners((signer, detail) => {
    const name = detail?.info?.name ?? 'Browser wallet';
    if (!seen.has(name)) { seen.add(name); out.push({ id: `eip6963:${name}`, name, signer }); }
  });
  return out;
}

export async function connect(opt: WalletOption): Promise<WalletInfo> {
  await opt.signer.connect();
  return readInfo(opt);
}

export async function readInfo(opt: WalletOption): Promise<WalletInfo> {
  const address = await opt.signer.getRecommendedAddress();
  const balance = await opt.signer.getBalance();
  return { address, balance, wallet: opt.name };
}

export function formatCkb(shannons: bigint): string {
  const whole = shannons / 100_000_000n;
  const frac = (shannons % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '');
  return `${whole.toString().replace(/\B(?=(\d{3})+$)/g, ' ')}${frac ? '.' + frac : ''} CKB`;
}
