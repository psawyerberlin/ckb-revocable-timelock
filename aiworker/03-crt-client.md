# Spec 03 — the CRT client library (`crt-client`)

**Branch:** `aiworker/crt-client`. **Acceptance:** `acceptance/aiworker-crt-client/`.
**Depends on:** spec 01 (vectors and layouts only; no Rust is needed to build the client).
**Normative:** `SPEC.md` §2, §3, §6, §7, §8, §9.

TypeScript, ESM, runs in browsers and Node ≥ 22. Package `client/` named `@crt/client` (private, not published in
v0.1). Build with `tsc` to `dist/` (ES2022, `.d.ts`); tests with `node:test` through `tsx` **or** `vitest` (one
choice, in `DECISIONS.md`). Dependencies allowed: `@noble/secp256k1` (2.x), `@noble/hashes` (1.x),
`@ckb-ccc/core` (latest 1.x) — nothing else at runtime. The CSR job builder is the vendored
`client/vendor/csr-job.mjs` (copied from the CSR checkout at a tag; the tag in a header comment; a test checks
its SHA-256 against `client/vendor/csr-job.sha256`, which the worker writes once).

## Phase 1 — primitives (`client/src/core/`)

| Module | Exports | Tests |
|---|---|---|
| `hash.ts` | `blake2b256(data, personalization = 'ckb-default-hash')`, `identity(networkId, typeId)`, `shareCommitment(share)`, `descriptorHash(descriptor)` (JCS, `SPEC.md` §8.1) | `spec/vectors/identity.json`, `spec/vectors/descriptor.json` |
| `shamir.ts` | `split(secret32, t, n, rng)`, `combine(shares)`; GF(2^8) poly `0x11b`, `x = 1..n`, share = `x ‖ y[32]` | `spec/vectors/shamir.json` (combine vectors), random round trips for every `(t, n)` with `t ≤ n ≤ 12`, wrong share detected by commitment not by combine |
| `envelope.ts` | `wrap(pubkey33, m, aad, rng)`, `unwrap(privkey32, envelope, aad)` per `SPEC.md` §7.2; WebCrypto AES-GCM (Node: `globalThis.crypto`) | round trips, tampered byte fails, wrong aad fails, KAT of the HKDF step (fixed `s`, `E`, `P` → key) stored in `client/test/kat-hkdf.json` (worker-generated, checked in) |
| `tree.ts` | `AccessTree` types, `validateTree`, `leafPositions(tree)` (depth-first), `splitKey(K, tree, rng) → {leafSecrets[], commitments[]}`, `combineKey(tree, leafSecrets: Map<position, bytes>) → K`, `headroom(tree, armedPositions)` (threshold and mandatory, separately) | threshold, xor(threshold, threshold), reject unsupported shapes, headroom table |
| `cells.ts` | `NodeCellData` encode/decode (139 bytes), `aliveCellData`, `isAliveCell(cell)`, `sinceAbsoluteTimestamp(seconds)` | round trips, rejects bad length/version |
| `payload.ts` | `jobPayload(T)`, `parseResult(bytes)` | vectors |
| `cost.ts` | `estimateCost({deployment, n, termSeconds, heartbeatBlocks, heartbeatTipShannons, keygenTipShannons, maxFeeShannons, organiserFeeShannons, fiatPerCkb?}) → {spentNow, spentOverTerm, parked, parkedTransient, monthly, detectionDelaySeconds, lines[], assumptions}` per `SPEC.md` §11.1; `SWITCH_PARAM_RANGES` of §6.2 and `validateSwitchParams` | `cost_estimate_defaults` (defaults → spent 1 530 ± 2 %, parked 4 440 ± 2 %), `cost_scales_with_heartbeat` (halving `HEARTBEAT` doubles the tip line), `switch_params_ranges` |
| `canon.ts` | JCS (RFC 8785) for the JSON subset used here (no floats: all numbers are integers or strings) | RFC examples that fit the subset |

`rng` is injectable everywhere (`(n) => Uint8Array`) so tests are deterministic; the default is
`crypto.getRandomValues`.

## Phase 2 — chain access (`client/src/chain/`)

* `rpc.ts`: minimal JSON-RPC client (`fetch`), methods `get_cells` (indexer), `get_live_cell`, `get_transaction`,
  `get_tip_header`, `get_header`, `send_transaction`; retries once; works against several URLs in order.
* `deployment.ts`: loads `deployments/<network>.json` (schema in `deployments/README.md`: `network_id`,
  `node_lock` {code_hash, out_point}, `crt_code_hash`, `crt_data_hash`, `crt_data_cell` out point, `csr`
  {job_type, job_lock, registry_type_hash, registry_type_script, deployment json of CSR}, `type_id_code_hash`,
  `rpc_urls[]`, `monitor_url`), validates every field, computes **`crtServiceId(R)`** with `csr-job.mjs`'s
  `serviceId(crtCodeHash, R, [crtDataHash])`.
* `runners.ts`: reads CSR registry cells (`get_cells` on the registry type script; decodes `RegistryV3` by hand,
  10-field molecule table: `version, peer_id, service_pubkey, payout_lock_hash, network, stake, expiry_ms,
  attestation_sig, endpoint, prekeys`; `R` = last 32 bytes of the dual-lock args), fetches the monitor's
  `/v1/nodes/{peer_id}`, merges with `deployments/<network>-runners.json`, and returns `Runner[]` with the fields
  of `SPEC.md` §9 and a `diversityKey` (country/ASN cell when known). Pure selection helper
  `selectRunners(runners, {n, mandatory[], excludeSameDiversityKey: true})`.
* `switch.ts`: `readSwitch(T)` → `{alive, nodeCells[], deadline, descriptorHash, headroom, state}` from the chain;
  `verifyNodes(T, descriptorOrPlan)` implementing **hard-fail** `SPEC.md` §8.3 — throws `VerificationError` with
  the failing rule number; **no option, flag or environment variable disables any rule** (a test greps the source
  for `skipVerif`, `insecure`, `allowUnverified`, `--force` and fails if any appears).

## Phase 3 — transaction builders (`client/src/tx/`, CCC)

Each returns an unsigned `ccc.Transaction` the caller signs with any CCC signer (JoyID, Neuron via CCC, …):

`buildCreate({signer, deployment, deadline, runners: {R, servicePubkey}[], params: SwitchParams /* §6.2: heartbeatBlocks,
heartbeatTip, keygenTip, maxFee, organiserFee */})` (validated with `validateSwitchParams`) — Alive Cell (type-id args computed per CKB type-id rule from the first input and output index;
CCC has `ccc.hashTypeId` helpers — use them), `n` Node Cells (state 0), `n` keygen jobs, `n` heartbeat jobs
(`jobCell`, `jobCellDeps` from `csr-job.mjs`), optional organiser fee output, change; `completeInputsByCapacity`,
`completeFeeBy`. Returns also `{T, I, nodeCellIndices}`.
`buildArm(T, descriptorHash)`, `buildRenew(T, newDeadline, params?)` (defaults to the switch's current heartbeat parameters read from its job cells),
`buildRewrap(T, dropR[], addRunners[])` (destroys dropped Node Cells, creates new ones + jobs),
`buildCancel(T, {reclaimNodeCells: true})` (Alive Cell input, **no** type-id output; Node Cells reclaimed; no fee
output of any kind), `buildReclaim(T)` (Node Cells + expired job cells with `since = expiry_block`, `jobCellDeps`
without registry dep, per CSR `docs/integrating-an-app.md`).

Tests: build each transaction against a mocked RPC (fixtures of cells) and assert the outputs' scripts, data and
capacities; `buildCancel` has no output with the type-id script; `buildCreate` puts `descriptor_hash = 0` and
`state = 0`; job payloads equal `jobPayload(T)`; the heartbeat job's `remainingRuns = ceil(term / heartbeat)`;
`minJobCapacity` respected.

## Phase 4 — descriptor, kit, recovery (`client/src/kit/`)

* `descriptor.ts`: `buildDescriptor(plan, chain)`, `descriptorHash`, `validateDescriptor` (schema of `SPEC.md`
  §8.1, `client/schema/descriptor.schema.json` — JSON Schema 2020-12, written by the worker and used by the test).
* `wrapKey(K, descriptor, rng) → envelopes[]` (one per leaf, `aad = I ‖ position`), `unwrapAll(descriptor,
  envelopes, releases: Map<R, privkey>) → K` (verifies `pubkey(d) == node.pubkey`, commitments, then combine;
  reports which leaves failed and why).
* `kit.ts`: `generateKit({descriptor, envelopes, application?, kitVersion}) → string` producing the single HTML of
  `SPEC.md` §8.2 from `client/kit/template.html` + `client/kit/recovery.ts` bundled (esbuild or `vite build
  --lib`, into a single IIFE string inlined at build time; the generated HTML has **no** external reference: a
  test parses it and asserts no `src=`/`href=` to `http`, no `@import`, no `url(`). Deterministic: generating
  twice gives identical bytes (test). Size < 400 KB (test). The certificate section is plain HTML with print CSS.
  Self-verification banner, the application hook, `window.CRT_KIT.api` and `<div id="crt-application">` as
  specified in `SPEC.md` §8.2.
* `recover.ts` (also what `recovery.ts` in the kit uses): `collectReleases(T, rpcUrls)` → Node Cells in state 2 →
  `Map<R, privkey>`; `recoverOffline(descriptor, envelopes, pasted[])`.

Tests: full offline round trip — plan 5-of-8 with a 2-of-3 mandatory branch → `K` → envelopes → simulate release
of exactly `t` nodes → `K` back; one node short → fails with the headroom message; a garbage release value
identified by commitment; kit determinism and self-containment.

## Phase 5 — CLI and docs

`client/bin/crt.ts` (`npx crt …`): `runners --network testnet`, `plan`, `create` (prints the unsigned tx JSON
for offline signing *and* can sign with a `--key` for devnet only), `status T`, `arm`, `renew`, `cancel`,
`kit`, `recover`. Every command works with `--rpc URL` alone (no coordinator). `client/README.md` (API, examples),
`docs/developers.md` (exists; fill the integration walkthrough with real code from this library),
`CHANGELOG.md`.

## Acceptance

```sh
node --test acceptance/aiworker-crt-client/
node acceptance/aiworker-crt-client/named.mjs      # runs `npm test` in client/ and greps the report for the fixed test names
```

Fixed test names (any runner; the `named.mjs` script looks for these strings in the test output):
`identity_vectors`, `descriptor_hash_vector`, `shamir_combine_vectors`, `shamir_roundtrip`, `envelope_roundtrip`,
`envelope_tamper_fails`, `tree_xor_threshold_roundtrip`, `headroom_separate`, `nodecell_roundtrip`,
`verify_hard_fail_no_override`, `build_cancel_has_no_typeid_output`, `build_create_layout`, `kit_deterministic`,
`kit_self_contained`, `kit_under_400kb`, `recover_offline_roundtrip`, `csr_job_vendor_hash`, `cost_estimate_defaults`, `cost_scales_with_heartbeat`,
`switch_params_ranges`.
