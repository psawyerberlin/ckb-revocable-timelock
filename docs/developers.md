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
import { loadDeployment, listRunners, selectRunners, buildCreate, buildArm, readSwitch, verifyNodes,
         buildDescriptor, splitKey, wrapKey, generateKit, buildCancel } from '@crt/client';

const dep = await loadDeployment('testnet');                 // deployments/testnet.json
const signer = /* a CCC signer, e.g. JoyID */;

// 1. choose runners: staked, attested, diverse; 5-of-8 by default for terms under a year
const runners = await listRunners(dep);
const plan = selectRunners(runners, { n: 8 });
const deadline = Math.floor(Date.now() / 1000) + 180 * 86400;

// 2. create: one transaction — Alive Cell, 8 Node Cells, 8 keygen jobs, 8 heartbeat jobs
const { tx, T, I } = await buildCreate({ signer, deployment: dep, deadline, runners: plan, heartbeatBlocks: 8000n,
                                         termBlocks: 180n * 8000n, organiserFee: 0n });
await signer.sendTransaction(tx);

// 3. wait for the 8 commits (Node Cells in state 1), then verify — hard fail, no override
let sw; do { sw = await readSwitch(dep, T); } while (sw.nodeCells.filter(c => c.state === 1).length < 8);
await verifyNodes(dep, T, plan);                            // throws VerificationError(rule) on any mismatch

// 4. descriptor and arm
const descriptor = await buildDescriptor(dep, T, plan, { kind: 'threshold', t: 5, n: 8, leaves: plan.map((_, i) => ({ node: i })) });
await signer.sendTransaction(await buildArm({ signer, deployment: dep, T, descriptorHash: descriptor.descriptor_hash }));

// 5. your encryption
const K = crypto.getRandomValues(new Uint8Array(32));
const ciphertext = await yourEncrypt(K, plaintext);          // AES-256-GCM in the browser, your format
const envelopes = await wrapKey(K, descriptor);              // one envelope per leaf, AAD = I ‖ position
const kitHtml = generateKit({ descriptor, envelopes, application: { name: 'your-app', version: '1', payload: { ciphertext } } });
download('kit.html', kitHtml);                               // the only artefact the heir needs

// later: cancel = one signed transaction, no fee of any kind
await signer.sendTransaction(await buildCancel({ signer, deployment: dep, T }));
```

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
