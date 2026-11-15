import type { NetworkName } from './networks.ts';
import type { WalletInfo, WalletOption } from './wallet.ts';

/** Shared state of the shell: network and connected wallet. Screens read it; the shell writes it. */
export const session: { network: NetworkName; wallet?: WalletOption; info?: WalletInfo } = { network: 'testnet' };

const listeners = new Set<() => void>();
export const onSession = (fn: () => void): void => { listeners.add(fn); };
export function updateSession(patch: Partial<typeof session> & { wallet?: WalletOption | undefined; info?: WalletInfo | undefined }): void {
  Object.assign(session, patch);
  for (const l of listeners) l();
}
