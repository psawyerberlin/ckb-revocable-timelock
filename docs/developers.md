# Integrating CRT into an application (developers)

CRT gives your application two things: a set of **public keys** to encrypt to, and later the matching **private
keys**, released on chain when the switch's deadline passes without the owner cancelling. Everything else — what
you encrypt, where you keep the ciphertext, who the recipients are — is yours. The reference application is
[dead-man-switch](https://github.com/psawyerberlin/dead-man-switch).

## The contract with your application

1. **You never send plaintext anywhere.** Encrypt in the user's browser with a content key `K` you generate.
2. **CRT splits `K` for you** (`@crt/client`: `splitKey` with an access tree, `wrapKey` to the nodes' public keys)
   and gives you back *envelopes*. Store the envelopes next to your ciphertext. CRT never sees `K`.
3. **The recovery kit is yours to extend.** `generateKit({descriptor, envelopes, application})` produces one
   self-contained HTML file; your `application.payload` (your ciphertext, your metadata) travels inside it and
   your hook `window.crtApplication.onKey(K)` runs after the kit has recovered `K`. The result is a single file an
   heir can open in 2040 from a USB stick.
4. **Cancel is one wallet transaction** (`buildCancel`). Make it as visible as "create".

## Walkthrough (TypeScript, `@crt/client` + CCC)

```ts
import { ccc } from '@ckb-ccc/core';
import { loadDeployment, RpcClient, fetchRunners, selectRunners, readSwitch, buildCreate, buildArm, buildCancel,
         defaultSwitchParams, buildVerifiedDescriptor, wrapKey, descriptorHash, generateKit, KIT_VERSION } from '@crt/client';

const deployment = await loadDeployment('testnet');          // deployments/testnet.json (Node); browsers use parseDeployment
const rpc = new RpcClient(deployment.rpc_urls);
const sctx = { rpc, deployment };
const signer: ccc.Signer = /* any CCC signer, e.g. JoyID */;

// 1. choose runners: staked, attested, diverse; 5-of-8 by default for terms under a year
const runners = selectRunners(await fetchRunners({ rpc, deployment }), { n: 8 });
const deadline = BigInt(Math.floor(Date.now() / 1000) + 180 * 86400);

// 2. create: one transaction — Alive Cell, 8 Node Cells, 8 keygen jobs
const { tx, T } = await buildCreate({
  signer, deployment, deadline, params: defaultSwitchParams(), validation: { t: 5 },
  runners: runners.map((r) => ({ R: r.R, servicePubkey: r.servicePubkey })),
});
await signer.sendTransaction(tx);

// 3. wait until all 8 Node Cells are committed (state 1)
let sw;
do { await new Promise((r) => setTimeout(r, 15_000)); sw = await readSwitch(T, sctx); }
while (sw.nodeCells.filter((c) => c.data.state === 1).length < 8);

// 4. K, descriptor (hard-fail verification of SPEC §8.3 runs inside; there is no override) and arm
const K = crypto.getRandomValues(new Uint8Array(32));
const descriptor = await buildVerifiedDescriptor({
  K,
  access_tree: { kind: 'threshold', t: 5, n: 8, leaves: runners.map((_, i) => ({ node: i })) },
  nodes: runners.map((r) => ({ runner_lock_hash: r.R, service_pubkey: r.servicePubkey, peer_id: r.peerId })),
}, T, sctx);
await signer.sendTransaction(await buildArm(T, descriptorHash(descriptor), { signer, deployment }));

// 5. your encryption, then the envelopes and the kit
const ciphertext = await yourEncrypt(K, plaintext);          // AES-256-GCM in the browser, your format
const envelopes = await wrapKey(K, descriptor);              // one envelope per leaf, AAD = I ‖ position
const kitHtml = generateKit({ descriptor, envelopes, kitVersion: KIT_VERSION, deadline,
                              application: { name: 'your-app', version: '1', payload: { ciphertext } } });
download('kit.html', kitHtml);                               // the only artefact the heir needs

// later: cancel = one signed transaction, no fee of any kind
await signer.sendTransaction(await buildCancel(T, { reclaimNodeCells: true }, { signer, deployment }));
```

`wrapKeyAnchored(K, descriptor, sctx)` is the stricter variant: it refuses unless every Node Cell already carries the
descriptor hash, so call it after the Arm transaction is mined.

The same flow from a shell: `npx crt plan`, `crt create`, `crt arm`, `crt kit`, `crt cancel` (see `client/README.md`).

Recovery without your application: the kit alone recovers `K`; with your application hook it also decrypts your
payload. Recovery without the kit: anyone who still has the descriptor and the envelopes can rebuild the kit
(`generateKit` is deterministic).

## What to show your users

Taken from `SPEC.md` §10–§12, in plain words:

* the duration risk (runners leave; rewrap at renewal), the two headroom figures, the mandatory-node trade;
* that a runner dishonest from day one is not defended against — hence thresholds and diverse runners;
* the cost split: spent (tips) vs locked (cells, refundable);
* that the release values become public on chain: whoever has the kit can decrypt after the deadline. The kit is
  the secret-bearing artefact of your application; CRT's own data is all public.

## Costs

`SPEC.md` §11. For the default 8 runners and one year: ≈ 1 530 CKB spent and ≈ 4 440 CKB locked (refundable). Your
application may add its own organiser fee output in `buildCreate`; cancel must stay free.

## Running the pieces yourself

* Devnet with three runners, one command: `scripts/devnet-e2e.sh` (spec 05).
* Operators: `docs/operators.md`. Contracts: `docs/contracts.md`. Service: `docs/service.md`.
