import { ccc } from '@ckb-ccc/core';
import mainnetDeployment from '../../deployments/mainnet.json';

export type NetworkName = 'testnet' | 'mainnet';

export const MAINNET_ENABLED: boolean = (mainnetDeployment as { enabled?: boolean }).enabled === true;
export const MAINNET_DISABLED_TEXT = "CRT is on testnet until CSR's service runtime opens on mainnet";

export function isNetworkAvailable(n: NetworkName): boolean {
  return n === 'testnet' || MAINNET_ENABLED;
}

export function makeClient(n: NetworkName): ccc.Client {
  if (!isNetworkAvailable(n)) throw new Error(MAINNET_DISABLED_TEXT);
  return n === 'mainnet' ? new ccc.ClientPublicMainnet() : new ccc.ClientPublicTestnet();
}
