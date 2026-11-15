# @crt/client

TypeScript client for CKB Revocable Timelock (CRT): ESM, Node >= 22 and browsers. Private package in v0.1.
`SPEC.md` is normative; this file shows how to use the library and the `crt` command.

## Library

```ts
import { loadDeployment, RpcClient, fetchRunners, selectRunners, buildCreate, defaultSwitchParams,
         buildVerifiedDescriptor, wrapKey, generateKit, KIT_VERSION, recoverOffline } from '@crt/client';
```

| Area | Exports |
|---|---|
| core | `blake2b256`, `identity`, `split`/`combine` (Shamir), `wrap`/`unwrap` (envelope), `splitKey`/`combineKey`/`headroom` (access trees), `estimateCost`, `validateSwitchParams`, node cell codecs |
| chain | `RpcClient`, `loadDeployment`, `fetchRunners`, `selectRunners`, `readSwitch`, `verifyNodes` (throws `VerificationError`, no override) |
| tx | `buildCreate`, `buildArm`, `buildRenew`, `buildRewrap`, `buildCancel`, `buildReclaim` (unsigned CCC transactions) |
| kit | `buildDescriptor`, `buildVerifiedDescriptor`, `wrapKey`, `wrapKeyAnchored`, `unwrapAll`, `generateKit`, `recoverOffline`, `recoverOnline` |

The full integration walkthrough with real code is in [`docs/developers.md`](../docs/developers.md).

## Command line

Run from `client/` (`npm ci` first): `npx tsx bin/crt.ts <command>` or `npm run crt -- <command>`. Every command works with
`--rpc URL` alone; no coordinator is involved. Transactions are printed unsigned, for offline signing; `--key HEX` signs
and sends on a devnet only.

```sh
crt runners --network testnet --rpc https://testnet.ckb.dev/
crt plan --n 8 --t 5 --out plan.json
crt create --plan plan.json --deadline 2027-05-01 --owner ckt1... --out create.json   # prints T and I too
crt status 0x<T>
crt arm 0x<T> --plan plan.json --owner ckt1... --secret-out k.hex --out arm.json      # verifies, writes descriptor.json + envelopes.json
crt kit --descriptor descriptor.json --envelopes envelopes.json --out kit.html
crt renew 0x<T> --deadline 2027-08-01 --owner ckt1...
crt cancel 0x<T> --owner ckt1...
```

### recover

After the deadline passes without a cancel the runners release their keys on chain.

```sh
# from the chain
crt recover --descriptor descriptor.json --envelopes envelopes.json --rpc https://testnet.ckb.dev/
# offline, from pasted release values (private keys, 0x hex)
crt recover --descriptor descriptor.json --envelopes envelopes.json --release 0x... --release 0x...
```

When too few nodes have released, `recover` fails and reports the threshold and mandatory headroom and every bad leaf.
The recovery kit (`crt kit`) does the same in a browser from one HTML file.

## Tests

`npm test` (node:test through tsx); `npm run typecheck`; `npm run build` (kit assets, then `tsc` to `dist/`).
