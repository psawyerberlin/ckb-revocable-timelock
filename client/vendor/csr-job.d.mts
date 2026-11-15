// Type declarations for the vendored csr-job.mjs (not part of the hashed file).
export interface OutPointLike { txHash: string; index: number }
export function encodeJob(job: any): string;
export function decodeJob(hex: string): any;
export function loadDeployment(json: any): any;
export function minJobCapacity(a: { deployment: any; serviceId: string; job: any }): bigint;
export function jobCell(a: { deployment: any; serviceId: string; job: any; extraCapacityShannons?: bigint }): {
  cellOutput: { capacity: string; lock: { codeHash: string; hashType: string; args: string }; type: { codeHash: string; hashType: string; args: string } };
  outputData: string;
};
export function jobCellDeps(deployment: any): { outPoint: OutPointLike; depType: string }[];
export function watchPayload(outPoint: OutPointLike, innerHex?: string): string;
export function blake2b256(data: Uint8Array): Uint8Array;
export function serviceId(codeHash: string, argsHex?: string, dataHashes?: string[]): string;
