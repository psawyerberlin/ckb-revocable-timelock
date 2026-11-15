# Decisions log (AI worker)

Newest spec first. One `##` section per spec, one bullet per decision: what was unspecified or contradictory,
what was chosen and why. Protocol-changing decisions are also proposed as a `SPEC.md` diff in the PR body
(`AIWORKER.md` §5).


## Spec 05 (crt-devnet-e2e), Phase 1: devnet script

- `scripts/devnet-e2e.sh` is written and only statically checked (`bash -n`, `--help`); no devnet was started.
- The spec says `crt-enable.sh --csr-bin … --data-root …`; the existing script takes `--csr PATH` and `--workdir`.
  Each runner gets a wrapper `.devnet/e2e/runnerN/csr` that pins `--data-root`/`--config`, passed as `--csr`.
- `crt-enable.sh` only accepts `testnet|mainnet`; the devnet 102-byte data cell is built by the e2e script and
  passed with `--data-cell`. `deployments/devnet.json` (written by the script) carries `node_lock`,
  `network_id` 2 and the Type ID code hash.
- Idempotence: markers/JSON files under `.devnet/e2e/`; runners are only started when their pidfile is dead.
- Exact `csr-dev`/`csr` JSON field names (`runner_lock_args`, `peer_id`, `message`, `tx_hash`, `index`) follow CSR
  docs/testing.md and must be confirmed on the first manual run.

## Spec 04 — `crt-web` (`aiworker/04-crt-web.md`)

### Phase 4 — quality and build

- 2026-11-15 — Test runner: `vitest` with `jsdom` and `@testing-library/dom` (Playwright needs a browser download, unavailable offline). `vitest.config.ts` merges `vite.config.ts` so the `@crt/client` alias applies. `src/wallet.ts` is mocked in tests (no wallet or network).
- 2026-11-15 — "Cancel reachable in ≤ 2 clicks" is tested as: Cancel (opens confirmation), then the confirm button exists and is `primary` like Create. The test does not click confirm (it would sign).
- 2026-11-15 — The default quote test uses a one-year term, n = 8 defaults from `SWITCH_PARAM_RANGES`, and asserts the ±2 % bands both via `computeQuote` and via the rendered Quote screen after moving the heartbeat slider (`web_cost_panel_live`).
- 2026-11-15 — `npm test` = `vitest run` followed by `scripts/check-external.mjs` (greps `dist/` for hosts outside the allowed list, same list as the acceptance test). It runs after `npm run build` in the acceptance runner.

- 2026-11-15 — The CCC bundle contained hosts the app never contacts (second RPC mirror `*.ckbapp.dev`, `api.ckbccc.com` and `nervosnetwork.github.io` documentation links in error text, COTA aggregator), which failed the external-reference check. A post-build Vite plugin in `vite.config.ts` (`stripUnusedHosts`) drops the mirror from CCC's default URL list and points the doc links at github.com; the COTA aggregator (unused: no COTA calls) points at an inert path on the app's own host. The RPC used remains `*.ckb.dev`.

### Phase 3 — manage and recover

- 2026-11-15 — Routes `#/switches` (My switches) and `#/recover`, linked from the header and the home page. The local list is `localStorage['crt.switches']` keyed by `T` (filtered by network); "Add by T" adds an entry without descriptor. The kit HTML (encrypted envelopes only, no secret) is also stored per `T` in `localStorage['crt.kits']` when the create flow builds it, so "Download kit again" and headroom (which needs the access tree from the descriptor) work later; a switch added by T only shows "headroom unknown".
- 2026-11-15 — Countdown uses the chain median time (`get_blockchain_info.median_time`), not the local clock. "Last heartbeat age" = median time minus the block timestamp of the transaction that created each runner's live heartbeat job cell (it is recreated on every run); if unreadable it shows "unknown" and the runner counts as armed for headroom. A runner is stale when the age exceeds 3 × HEARTBEAT (SPEC §6.1), using the switch's recorded heartbeat blocks (default 8 000).
- 2026-11-15 — Cancel: one click opens an inline confirmation, a second click signs. Both buttons use the `primary` style, the same size as Create; red fill. Cancel reclaims the Node Cells in the same transaction (`reclaimNodeCells: true`). Renew asks for a UTC date later than the current deadline and keeps the existing heartbeat parameters. Rewrap lists current runners (drop) and directory runners (add) and says a new Arm and kit follow. Reclaim builds one transaction per click (the job lock takes one job input per transaction).
- 2026-11-15 — Recover needs no wallet: it uses the selected network's deployment, `collectReleases`, and with a loaded kit `unwrapAllReport` (per-leaf status table). With K: download as hex and "Hand K to the application slot" (`window.crtApplication.onKey`, reports when no slot exists). Without K: the headroom shortfall. With T only (no kit) it lists released runners and asks for the kit, since envelopes are not on chain. K is never rendered.
- 2026-11-15 — Nothing here ran against a chain; checked by typecheck and build only.

### Phase 2 — create flow

- 2026-11-15 — Routing is hash-based (`#/create/<step>`, steps deadline → runners → quote → create → arm → kit): the app is a static directory under `/app/`, so no server rewrite is needed. State lives in `src/draft.ts` (sessionStorage, amounts as shannon strings); the secret `K` is held in memory only and never stored. The kit (encrypted envelopes only) is kept in sessionStorage until "Finish".
- 2026-11-15 — `@crt/client` is consumed from source (`../client/src`) through a Vite alias and a small plugin that resolves the client's bare imports (`@noble/*`, `@ckb-ccc/core`) from `web/node_modules`; `tsconfig.json` has matching `paths`. No package build of the client is needed.
- 2026-11-15 — Deployment files are bundled with `import.meta.glob('../../deployments/*.json')`, so a missing `testnet.json` (none exists in the repository yet) does not break the build; the Runners screen then says that no deployment file exists.
- 2026-11-15 — Mandatory runners: access tree `xor(threshold t-of-n over all runners, threshold j-of-m over the marked ones)`, the mandatory branch last (SPEC §7.3). `j` defaults to 1 and is editable when more than one runner is marked. "I understand" is required when exactly one runner is marked and the term exceeds 1 year (`SWITCH_PARAM_RANGES.oneOfOneMandatoryTermSeconds`).
- 2026-11-15 — Suggested structure follows SPEC §10: 5-of-8 under a year, 6-of-12 above (n changes with the deadline; the user can edit both). "Pick for me" uses `selectRunners` with `requireDepositedValid: false`, because the monitor may be unreachable; the table shows monitor status either way.
- 2026-11-15 — "Switches served" = Node Cells whose lock args end with the runner's `R`, counted from one prefix scan of the node lock; shown as "—" if the indexer query fails. Country/ASN comes from the client's `diversityKey`; "unknown" never counts as a collision.
- 2026-11-15 — All switch parameters (heartbeat slider, tips, max fee, organiser fee) live on the Quote screen so the estimate updates live, as SPEC §6.2 asks. The quote is always `estimateCost`; for the defaults it gives 1 524.84 spent / 4 441 locked (SPEC table: ≈1 530 / ≈4 440).
- 2026-11-15 — Organiser fee: default 50 CKB per SPEC, shown as its own line, editable to 0 (button). The organiser address is app-defined and none is configured in this repository: it is read from `VITE_CRT_ORGANISER_ADDRESS` at build time. Without it, Create refuses a non-zero fee with a message telling the owner to set it to 0 (no invented address).
- 2026-11-15 — Create waits for commits by polling `readSwitch` every 6 s and listing each runner (unconfirmed / waiting / committed). Arm is enabled only when all runners are in state ≥ 1. The switch is also added to the local `crt.switches` list (key `T`) for phase 3.
- 2026-11-15 — Arm: `buildVerifiedDescriptor` (hard fail) runs first; a `VerificationError` becomes a "MISMATCH (rule N)" block with the rule number and no button to continue. The owner may paste their own 32-byte secret or let the app generate one (shown once, hex). The kit is built (`wrapKey`; the anchored variant needs the Arm already mined) before Arm is signed, so a failed kit never leaves an armed switch without one.
- 2026-11-15 — Kit: file name `crt-kit-<first 8 hex of T>.html`; "Finish" stays disabled until "I have saved the kit" is ticked, and a `beforeunload` warning is active until then. "Mirror to coordinator" is a disabled, unchecked switch. Nothing here was run against a chain (none available); the flow is typechecked, built and its pure parts (quote, risk, coalition, tree) checked by script.
- 2026-11-15 — `npm test` is still the phase-1 placeholder; the vitest suite is phase 4.

### Phase 1 — shell and wallet

- 2026-11-15 — `web/` is a Vite + TypeScript project (no UI framework), `base: '/app/'`, `npm run build` = typecheck, `vite build`, then `scripts/copy-to-site.mjs` replaces `site/app/` with `web/dist/`.
- 2026-11-15 — Styles: `web/src/style.css` `@import`s `site/assets/site.css` (bundled into the build); dark mode comes from its `prefers-color-scheme` rules.
- 2026-11-15 — Mainnet option is disabled and the text "CRT is on testnet until CSR's service runtime opens on mainnet" shown while `deployments/mainnet.json` has `"enabled": false` (JSON imported at build time).
- 2026-11-15 — Wallets: `@ckb-ccc/joy-id` first, then EIP-6963 browser wallets via `@ckb-ccc/eip6963`; the full `@ckb-ccc/ccc` bundle (with its UI) is avoided. Address from `getRecommendedAddress`, balance from `getBalance`.
- 2026-11-15 — `@crt/client` is not imported yet (nothing in phase 1 needs it); it is wired in with phase 2.
- 2026-11-15 — Known for phase 4: the CCC bundle contains URLs for `api.ckbccc.com`, `cota.nervina.dev`, `*.ckbapp.dev`; the no-external-requests check must allow-list or strip them.

## Spec 03 — `crt-client` (`aiworker/03-crt-client.md`)

### Phase 5 — CLI and documentation

- 2026-11-15 — **CLI runner.** `client/bin/crt.ts` runs through `tsx` (`npm run crt -- <command>`, `bin` entry in `package.json`);
  no build step, same runner as the tests. Hand-written argument parser, no extra dependency.
- 2026-11-15 — **Signing.** Without `--key` the CLI needs `--owner ADDRESS` and prints the unsigned transaction JSON
  (CCC `Transaction.stringify`) for offline signing. `--key` signs and sends but is refused on `mainnet` and `testnet`.
- 2026-11-15 — **`arm`** does verification (hard fail, no flag), builds descriptor and envelopes from a plan and a secret `K`
  (generated unless `--secret`; stored only with `--secret-out`, mode 0600), writes `descriptor.json`/`envelopes.json` and
  prints the Arm transaction. It wraps with `wrapKey` (not `wrapKeyAnchored`), because the Node Cells carry the hash only
  after Arm is mined; the descriptor itself was verified against the chain.
- 2026-11-15 — `plan` writes `{network, nodes, access_tree}` (single threshold tree, default t = ceil(5n/8)); more
  elaborate trees are edited by hand in the plan file. `deployments/` is looked up in the cwd, then `../deployments`.
- 2026-11-15 — Added `src/index.ts` as package entry (`main`); `core/hash.ts`'s `descriptorHash` (bytes) is not re-exported
  there, the kit's `descriptorHash(descriptor)` (hex) is. CLI commands were checked by typecheck and `--help` only (no chain here).

### Phase 4 — descriptor, kit and recovery

- 2026-11-15 — **Deterministic splitting.** The share commitments are inside the descriptor whose hash goes on chain at
  Arm, before anything is encrypted, yet the API is `wrapKey(K, descriptor, rng)`. So `buildDescriptor(plan, chain)` takes
  `K` in the plan and the splitting randomness (XOR masks, Shamir coefficients) is a PRF of `K`:
  `HMAC-SHA256(K, "CRT/v1/split" ‖ I ‖ u32 BE counter)` (`splitRng`, `deriveLeafSecrets`). `wrapKey` re-derives the
  shares, refuses if they do not reproduce the descriptor's commitments ("K does not match"), and uses `rng` only for
  ephemeral keys and nonces. Client-side only; other clients may split however they like (the commitments say what to expect).
- 2026-11-15 — `buildDescriptor(plan, chain)` is pure: `chain = {T, deployment, aliveCell, nodeCells}` (the shapes returned
  by `verifyNodes`/`readSwitch`); it requires exactly one state-1 Node Cell with a valid point per planned runner.
  `buildVerifiedDescriptor(plan, T, ctx)` runs the SPEC §8.3 verification first; `wrapKeyAnchored(K, d, ctx)` refuses
  unless verification passes and every Node Cell already carries `descriptorHash(d)` (SPEC §6 "no wrap to an unanchored
  descriptor"). Both live in `kit/anchored.ts` so the kit bundle does not pull chain verification code.
- 2026-11-15 — `validateDescriptor` mirrors `client/schema/descriptor.schema.json` (JSON Schema 2020-12, `additionalProperties:
  false`, lowercase `0x` hex, integers only) plus semantic rules (identity = I(network_id, type_id), supported tree whose
  leaves index `nodes`, one commitment per leaf, unique runners and Node Cells). Curve membership of `pubkey` is **not** a
  schema/validation rule because the shared vector uses placeholder keys; `buildDescriptor` and `wrap` check it. Tests use
  `ajv` 8 (devDependency only) to check the schema against the vector and the same mutations as `validateDescriptor`.
- 2026-11-15 — Envelopes are `{position, node, runner_lock_hash, envelope: 0x hex}` (one per leaf, `aad = I ‖ u16 BE
  position`); `unwrapAll` also accepts a plain hex array indexed by position. `unwrapAll(descriptor, envelopes, releases)`
  returns `K` or throws `RecoveryError` whose message carries the headroom ("threshold headroom -1, mandatory headroom 0;
  branch 0: 4 of 5 required …") and every bad leaf; `unwrapAllReport` returns the per-leaf report (`ok`, `no-release`,
  `bad-privkey`, `missing-envelope`, `unwrap-failed`, `commitment-mismatch`) without throwing. Mandatory branch for the
  headroom split = phase-1 default (smallest branch).
- 2026-11-15 — `collectReleases(T, rpcUrls, {nodeLockCodeHash, fetch?})`: the third argument is needed because the lock code
  hash is not derivable from `T`. Only **live** Node Cells in state 2 are read (no history scan in v0.1), and a release is
  kept only if `pubkey(privkey)` equals the cell's pubkey. `recoverOffline(descriptor, envelopes, pasted[])` accepts bare
  private keys (matched to nodes by pubkey), `R:privkey`, or raw state-2 Node Cell data; `recoverOnline` is the chain variant.
- 2026-11-15 — Kit bundling: `scripts/build-kit.mjs` bundles `kit/recovery.ts` with **esbuild 0.28.2** (pinned devDependency,
  the version `tsx` already ships; IIFE, minified, legal comments kept at the end) and writes `src/kit/assets.generated.ts`
  (template + bundle as string constants, checked in) so `generateKit` needs no file access and works in browsers. Test
  `kit_assets_up_to_date` rebuilds in memory and compares; `npm run build` regenerates first. Bundle ≈ 37 KB.
- 2026-11-15 — `generateKit({descriptor, envelopes, application?, kitVersion, deadline?, rpcUrls?})`: `kitVersion` must equal
  `KIT_VERSION` ("1"), so same version + same inputs ⇒ same bytes; embedded JSON has sorted keys (input key order does not
  matter) and `<`/`>`/`&` escaped. The deadline is not in the descriptor (renewals move it), so it is an optional input
  printed as "at kit generation". Pre-filled RPC list: `https://mainnet.ckb.dev/`, `https://testnet.ckb.dev/`,
  `http://127.0.0.1:8114/` per network, editable in the page. `application.script` is inlined after the kit script
  (rejected if it contains `</script`); `window.CRT_KIT = {version, descriptor, envelopes, application, api}`.
- 2026-11-15 — A test runs the generated page's scripts in `node:vm` with a minimal DOM stub: banner MATCH (MISMATCH after
  editing the embedded descriptor), `CRT_KIT.api.recover(pasted)` returns `K` and calls `crtApplication.onKey`. No browser
  is available, so the real DOM wiring (buttons) is only type-checked.

### Phase 3 — transaction builders

- 2026-11-15 — `@ckb-ccc/core` 1.23 added as the third runtime dependency. All chain reads of the builders go through
  `signer.client` (a `ccc.Client`), so one `{signer, deployment}` context suffices; tests mock it with
  `ccc.ClientPublicTestnet.new({transport})` answering `get_cells`/`get_tip_header` from fixtures, and a
  `ccc.SignerCkbPublicKey` (no private key). Every builder ends with `completeInputsByCapacity` + `completeFeeBy` and
  makes sure at least one input carries the signer's lock (owner path of `crt-node-lock`, refund path of the job lock).
- 2026-11-15 — Signatures: `buildCreate(args)` as written (returns `{tx, T, I, nodeCellIndices, keygenJobIndices,
  organiserFeeIndex, ownerLockHash, params, warnings}`). The owner builders take the context as an extra **last**
  argument: `buildArm(T, h, ctx)`, `buildRenew(T, newDeadline, params?, ctx)`, `buildRewrap(T, dropR, addRunners, ctx)`,
  `buildCancel(T, opts?, ctx)`, `buildReclaim(T, ctx)`; `txBuilders(ctx)` returns them bound, with exactly the call
  shapes of the spec (`buildArm(T, h)`, `buildRenew(T, d, params?)`, …).
- 2026-11-15 — **Deviation from SPEC §6 / spec 03 (proposed SPEC change):** CSR's `csr-job-type` rejects more than one job
  output per service group in a transaction (job-cell-standard §3, F-CON-007, error 9), and a runner's keygen and
  heartbeat jobs have the same type script (service ID of that runner). Create therefore carries the `n` keygen jobs
  only; the `n` heartbeat jobs are created by **Arm** (for every runner without a live heartbeat job for `T`, params
  from `ctx.params`, else the switch's live heartbeat jobs, else the §6.2 defaults; `buildCreate` returns the validated
  params to pass on). Nothing needs heartbeats before Arm (the switch is not usable yet), and walking away after Create
  parks less capacity. Rewrap likewise creates keygen jobs for new runners; the next Arm adds their heartbeat jobs.
- 2026-11-15 — **Reclaim is one job per transaction:** the CSR job lock accepts exactly one job input (error 7). `buildReclaim`
  takes all Node Cells of `T` plus the expired job with the lowest `expiry_block` (`since` = expiry block, absolute
  block form, flags 0; only jobs with `refund_lock_hash` = signer lock and `expiry_block ≤ tip`); call again for the next
  job. Jobs are found per runner (`job_type` args = `crtServiceId(R)`, payload = `jobPayload(T)`); Rs come from the live
  Node Cells plus `ctx.runners` (needed after a cancel that already destroyed the Node Cells). No registry dep.
- 2026-11-15 — Heartbeat job term = `deadline + GRACE − now` (so the release run is covered); `remainingRuns =
  ceil(term_blocks / HEARTBEAT)` with `term_blocks = term / block_seconds` (10.8 s default as in the cost estimator,
  same epsilon); `expiry_block = tip + runs × HEARTBEAT + 7 days of blocks`; keygen `expiry_block = tip + 7 days`.
  `max_cycles` 100 M. "now" is the tip header timestamp unless `ctx.now` is given. Job cells use exactly
  `minJobCapacity` (`jobCell` of csr-job.mjs).
- 2026-11-15 — Create: output 0 Alive Cell (owner lock, type-id, occupied capacity), outputs 1..n Node Cells (244 CKB with
  a 64-byte-args data2 lock), then keygen jobs, then the organiser fee output (only if `organiserFee > 0`; needs
  `organiserLock` and must cover the output's occupied capacity, else an error), then change. `T =
  ccc.hashTypeId(inputs[0], 0)`: outputs are first laid out with `T = 0`, inputs collected, then rewritten with the real
  `T` (sizes do not depend on `T`) before the fee is completed; a check asserts input 0 did not change. No node-lock
  dep on Create (output locks do not run), job deps from `jobCellDeps`.
- 2026-11-15 — Arm requires every Node Cell in state 1 and a common deadline; it does not call `verifyNodes` itself (the
  caller verifies against the descriptor first, as SPEC §6 orders). Renew refuses a released switch and requires
  heartbeat params (argument or live jobs). Rewrap keeps the deadline and leaves kept Node Cells untouched (their old
  `descriptor_hash` is replaced by the next Arm). Cancel consumes the Alive Cell (+ Node Cells by default) and has only
  the signer's change as output; a final assertion rejects any type-id output.

Phase 2 — chain access

- 2026-11-15 — `csr-job.mjs` and `csr-job.sha256` were already vendored in phase 1 (v0.1 tag header, hash verified unchanged);
  not rewritten. A hand-written `vendor/csr-job.d.mts` gives TypeScript the types (outside the hashed file). The build
  config now uses `rootDir: .` with `allowJs` so the vendored module is emitted next to `src/` (`dist/src/…`, `dist/vendor/…`).
- 2026-11-15 — No `@ckb-ccc/core` in phase 2: the RPC layer uses plain JSON-RPC shapes (snake_case hex), `fetch` is injectable
  (`FetchLike`) so tests run against a mock chain. Each URL is tried `1 + retries` times (retries = 1) before moving to the next.
- 2026-11-15 — Deployment JSON: `csr.job_type`/`csr.job_lock` are `{code_hash, out_point}`; `csr.deployment` is the CSR JSON
  accepted by `csr-job.mjs` `loadDeployment` and must agree with `csr.registry_type_hash`. A file with `enabled: false`
  (mainnet today) is refused by `parseDeployment`. `loadDeployment(network)` reads `deployments/<network>.json` (Node only).
- 2026-11-15 — `RegistryV3` is decoded strictly (total size, offsets, field lengths, version 3). The monitor exposes no
  country/ASN today; `diversityKey` comes from the runner list (`country`, `asn`) or from the monitor if it adds them;
  runners with an unknown key never collide. `selectRunners` ranks `p2p_verified` first, then monitor rank, then `R`;
  mandatory runners are exempt from the deposited/valid filter, and runner-published `max_heartbeat_blocks` /
  `min_heartbeat_tip_shannons` filter candidates.
- 2026-11-15 — `readSwitch` counts "armed" as state 1; the heartbeat-freshness part of SPEC §6.1 needs job-cell history and is
  injected as `heartbeatFresh(R)`. Headroom is computed only when a descriptor with `access_tree` is passed. States:
  absent, cancelled, pending, committed, armed, released, inconsistent.
- 2026-11-15 — `verifyNodes` checks rules in order across all nodes (first failing rule is reported). Additions beyond the
  literal text, all failing closed: duplicate or ambiguous Node Cells, `type_id` ≠ T, recorded pubkey/`node_cell`/`alive_cell`
  mismatches, and, once Node Cells carry a `descriptor_hash`, the descriptor must hash to it (rule 4). The function has
  no option parameter; a test greps the sources for override-like tokens.

Phase 1 — primitives

- 2026-11-15 — Test runner: `node:test` through `tsx` (`tsx --test --test-reporter=tap`); TAP output is explicit so the
  acceptance regex (`ok N - name`) matches regardless of the Node default reporter. No vitest.
- 2026-11-15 — Runtime deps only `@noble/secp256k1` 2.x and `@noble/hashes` 1.x for now (`@ckb-ccc/core` is added in phase 3).
  Sources import with `.ts` extensions; the build uses `rewriteRelativeImportExtensions`.
- 2026-11-15 — `wrap`/`unwrap` are `async` (WebCrypto). Byte inputs are `Uint8Array`; hashes and cell fields that are
  already hex in the descriptor/vectors are `0x` hex strings in `NodeCellData`; `identity`/`shareCommitment`/`jobPayload`
  accept bytes or hex and return bytes.
- 2026-11-15 — `client/test/kat-hkdf.json` generated from fixed `d = 01..20`, `e = a0..bf`; the key was re-derived
  independently with Python `hmac` and matches.
- 2026-11-15 — `vendor/csr-job.mjs` is CSR v0.6.1 (`dace9b7`) `sdk/js/csr-job.mjs` with one header comment line
  prepended naming the tag; `csr-job.sha256` is the hash of that file as vendored.
- 2026-11-15 — Cost estimator: SPEC §11.1 says `block_seconds` is 10 s by default, but its reference table (8 000 blocks
  ≈ 1 day, 365 runs, ≈ 1 530 CKB) only holds at 86 400 / 8 000 = 10.8 s (at 10 s there would be 395 runs, ≈ 1 645 CKB,
  outside the ±2 % of `cost_estimate_defaults`). Default is therefore `DEFAULT_BLOCK_SECONDS = 10.8`, overridable per
  deployment (`deployment.blockSeconds`). `runs` subtracts 1e-9 before `ceil` to ignore float noise on exact multiples.
  `spentOverTerm` includes organiser fee and network fees (the table's "Spent" row); `spentNow` is organiser + network fees.
  Network fees default to 1 CKB in total. Job-cell occupied capacity is computed from the molecule `Job` layout
  (heartbeat 165 data bytes → 303 CKB, keygen 153 → 291 CKB); node cell 244 CKB, alive cell 65 CKB (53-byte lock).
- 2026-11-15 — Amounts are bigint shannons in, `number` CKB out. `validateSwitchParams(params, ctx?)` throws
  `SwitchParamsError` (with `.errors`) and returns warnings (n < 5, term > 5 years). A 1-of-1 mandatory node on a term
  > 1 year is an error unless `ctx.acknowledgedOneOfOne`. `SwitchParams` uses the names of §6.2 (`heartbeatBlocks`,
  `heartbeatTip`, `keygenTip`, `maxFee`, `organiserFee`).
- 2026-11-15 — Access trees: `threshold` and `xor` of ≥ 2 `threshold` branches; nesting and leaf-only branches rejected;
  a node may not appear twice inside one threshold. `splitKey` shares the XOR branch secrets (last = K ⊕ others) with
  Shamir; commitments are per leaf. `combineKey` uses the first `t` available shares per branch and does not check
  commitments (callers do). `headroom` for `xor`: the mandatory branch is `opts.mandatoryBranch` or, by default, the
  branch with the fewest leaves (last on ties); `threshold` headroom is the minimum over the other branches; a plain
  threshold tree has `mandatory: null`.
- 2026-11-15 — `parseResult` accepts `"CRT1" ‖ status` with or without the trailing 32-byte `T`.

## Spec 02 — `crt-service` (`aiworker/02-crt-service.md`)

Phase 5 — documentation

- Cycle numbers in `docs/service.md` are stated as "not measured": the smoke script was never run. The state-machine
  diagram is a text summary; `machine.rs` stays authoritative on check order.

### Phase 4 — devnet smoke script (written, not run)

- `scripts/devnet-service-smoke.sh` (`--help`, `bash -n` clean) and `scripts/devnet/crt-smoke.mjs` (plain JSON-RPC:
  tip, mine-to, node-state, cell-live, send, owner-lock-hash) with `csr-job.mjs` copied from CSR v0.6.1. Nothing was
  run: no devnet here; PASS output is not pasted (per task instructions).
- **Switch creation is pluggable.** `client/` does not exist yet and hand-building the create transaction needs
  signing details only checkable on a devnet, so the script takes `--create-switch CMD` (default
  `client/scripts/devnet-create-switch.mjs` if present) that prints `<T> <deadline>` and supports `--consume-alive T`.
  Wiring this up is part of the crt-devnet-e2e manual phase, as are the `csr-dev`/`csr` flags used (taken from CSR
  docs/testing.md, unverified against a live build).
- Clock advance: `mine-to` mines in batches via `devnet.sh mine` until the tip timestamp reaches
  `deadline + GRACE + 60`; this needs a devnet that can mine with future timestamps, to be confirmed in the manual phase.

### Phase 3 — binary, manifest, enable script

- 2026-11-15 — `main.rs` was already wired to `run()` in phase 2. `scripts/build-service.sh` mirrors
  `build-contracts.sh` (`--locked`, stripped, `service/build/crt-service.elf`, prints `CRT_CODE_HASH`).
- **Local manifests can name data cells.** CSR 0.6.1 `runtime/manifest.rs` accepts `data_cells = [paths]`, so
  `crt-local.toml.in` uses the same data cell as the on-chain manifest (rendered from `deployments/<network>.json`
  into a 102-byte file by `crt-enable.sh`); no second entry is needed. Placeholders: `@R@`, `@ELF@`, `@DATA@`.
- **`R`** comes from `csr identity --json`, which in 0.6.x prints `runner_lock_hash` directly; no own hashing needed.
  `--runner-lock-hash` overrides it (also used for `--dry-run` without a runner).
- `csr service add-local` prints `{code_hash,name}`; `approve`/`enable` take that code hash (the ELF data hash, which
  is the local registry key). The composite CRT service ID printed by the script is computed per
  `spec/service-manifest.md` §4. Re-running is a no-op (CSR keeps the status of a known service).
- The release asset is verified against `SHA256SUMS`; `--elf` skips the download. The dashboard URL printed is the
  CSR default; the real bind is in `csr.toml`. The script and `crt-disable.sh` were only checked statically
  (`bash -n`, `--dry-run`); nothing ran against a live CSR.

### Phase 2 — state machine

- 2026-11-15 — `machine::step(host, &CrtDeployment) -> Outcome { status, skeleton: Option<Skeleton> }` in
  `service/crt-service/src/machine.rs`; molecule encoding by hand in `src/tx.rs`; `CrtDeployment`, the result
  bytes and `run()` (load data cell → `step`) in `src/lib.rs`. `crt-core` is a path dependency inside this
  repository (`../../contracts/crt-core`). `ckb-types 1.1.4` (the version in `contracts/Cargo.lock`) is a
  dev-dependency only, for `skeleton_molecule_decodes`.
- **Deployment data cell is 102 bytes, not 97.** SPEC §5.5's field list (1 + 1 + 32 + 36 + 32) adds up to 102;
  the "97 bytes" in its prose is an arithmetic slip. The field list wins (`DEPLOYMENT_LEN = 102`). Proposed SPEC
  fix: "97 bytes" → "102 bytes".
- "Empty skeleton" means `tx_skeleton_put` is never called (CSR `host-interface.md`: empty or never called = no
  extra cells). The result is always written once, and it is always 37 bytes. When the payload does not parse,
  `T` in the result is 32 zero bytes. `bad_args` is checked before `bad_payload` (SPEC §5.2 order), but `T` is
  still taken from the payload if it is valid.
- `main.rs` is built only for riscv64. On the host it is an empty `fn main` and `ckb-std` is a riscv64-only
  dependency, so `cargo test` stays light. The `[[bin]]` has `test = false`. `run()` reports a missing or
  malformed deployment data cell as `bad_args` (an installation error), with no skeleton. Phase 3 wires
  `main.rs` to `run()`, which is already done.
- **Node Cell lookup.** `cells_query` matches args by prefix, so each candidate's `CellOutput` is read and only
  cells whose lock is *exactly* `crt-node-lock`/data2/`T ‖ R` count. Normally there is one candidate, which
  costs two `chain_read`s (output + data), matching SPEC's HOLD cost. If no candidate qualifies, the result is
  DROPPED. The recreated output is the input's `CellOutput` bytes, copied verbatim, so it has the same capacity
  and lock.
- **More than one Node Cell for `T ‖ R`.** In honest operation this does not happen: Create and Rewrap make one
  Node Cell per runner, and the lock's node path allows exactly one output with the same lock (error 12). But
  nothing stops a third party from creating a lookalike cell with the same lock and arbitrary data. Such a cell
  can never be spent through the node path with a wrong key: release would fail with error 21, and the service
  checks the key before it publishes anything. However, a state-0 lookalike with an early deadline would
  otherwise be recommitted with our pubkey and then released early, on-chain and valid. Therefore index 0 is
  used only if every qualifying candidate has byte-identical data; otherwise the status is `bad_payload`, with
  no skeleton and nothing deleted. The residual risk is a griefing DoS on that runner (documented, not a leak).
- A queried cell that `chain_read` reports dead (we lost a race with our own commit/release) gives `hold`:
  nothing is deleted or written, and the next run sees the new state. Undecodable Node Cell data, a malformed
  `cells_query` answer or an unexpected `kv_get` code all give `bad_payload` (inputs unusable; nothing written
  or deleted).
- `key_lost` also covers these cases: a stored entry that is not 32 bytes or not a valid scalar; a failed
  `kv_put` (quota), where nothing is committed and the next run tries KEYGEN again; eight bad draws; and, at
  RELEASE only, a stored key whose pubkey differs from the Node Cell's (it is never published). That check
  needs a scalar multiplication, so HOLD skips it and stays cheap. The return codes of `kv_mark_secret`,
  `delete_on_consume` and `tx_skeleton_put` are not acted on, because a run cannot do anything useful about
  them.
- RELEASE `since` is `0x40 ‖ (deadline + GRACE)`, not the current median time. A deadline whose
  `deadline + GRACE` overflows or exceeds 56 bits stays in HOLD forever, because no `since` can express it.
- Release build for riscv64 (`cargo build --release --target riscv64imac-unknown-none-elf`) succeeds: the
  binary is about 71 208 bytes. Phase 3's build script will produce the definitive one.
- Extra tests beyond the named ones: `keygen_redraws_out_of_range_scalar` and `lost_race_holds_and_keeps_key`.

### Phase 1 — host bindings and mock host

- 2026-11-15 — `service/` workspace with `crt-host` and `crt-service` (lib stub; the state machine follows in
  phase 2). `ckb-std` pinned `=1.1.0` as in CSR's `services/rust`; `crt-host` itself needs no dependency: it uses
  a raw `ecall` wrapper (CSR's `csr-svc` convention) for the service calls and for CKB `load_script` (2052) /
  `load_cell_data` (2092, index 1, `Source::CellDep` = 3). No path dependency on the CSR checkout.
- Wrappers return raw host codes; buffer-out calls return `(code, full_len)`. `load_script_args` reads the
  `Script` into a 512-byte stack buffer, validates the molecule table layout by hand and copies the args; a
  larger or malformed script gives code 12.
- `trait Host` has `Syscalls` (real) and `MockHost` (`cfg(test)` or feature `mock`, forwarded as
  `crt-service/mock`). Mock "random" bytes are a splitmix64 stream, overridable per call through `random_queue`
  (needed to test the scalar-out-of-range redraw); `kv_put_fail` injects quota errors. Off riscv64 the raw syscall
  returns `u64::MAX`.


## Spec 01 — `crt-contracts` (`aiworker/01-crt-contracts.md`)

### Phase 5 — documentation

- 2026-11-15 — `docs/contracts.md` references SPEC §4.3 for the error table instead of copying it; cycles and data
  hash taken from phase 3/4 measurements (hash re-verified against the current binary).

### Phase 4 — `crt-contract-tests`

- 2026-11-15 — `ckb-testtool` 1.1.1 (CSR's version). Harness in `src/lib.rs`, the 24 named tests in
  `tests/node_lock.rs`. `build.rs` runs `scripts/build-contracts.sh` into `contracts/build/cargo-target` only
  when `contracts/build/release/crt-node-lock` is missing, as CSR does.
- Measured: the release transaction (Node Cell + runner wallet input, Alive Cell dep) takes **2 298 371 cycles**
  with the phase 3 binary (data hash `0x8e389ff2…26ff751`, unchanged); budget 60 M, verifier limit 70 M.
- Owner and runner wallet are always-success locks (`hash_type data1`) told apart by their args; the lock is
  referenced with `hash_type data2`. The Alive Cell dep has type `{TYPE_ID_CODE_HASH, type, T}`, an
  always-success lock and data `CRT\x01`; ckb-testtool does not run type scripts of deps, so no type-id binary.
- `node_release_changes_pubkey_rejected` expects **21**: the output carries another self-consistent key pair,
  and the pubkey is not among the error-11 fields (phase 3 rule order).
- Error assertions match `"error code {n} "` in the verifier's error (CSR's helper). Only the node lock can fail
  in these transactions (all other scripts are always-success), so the script is not matched by name.
- Some tests cover several cases in a loop: `bad_args_length_rejected` (0, 32, 63, 65 bytes),
  `bad_data_length_rejected` (0, 138, 140 bytes, with the owner's input present, so this also checks that
  undecodable data fails before the owner path), `node_state2_to_anything_rejected` (2 → 0, 1, 2).
- The test since values are not checked against headers (ckb-testtool runs only scripts); the lock reads
  `since` itself, which is what these tests are about.

### Phase 3 — `crt-node-lock`

- 2026-11-15 — Release build (`scripts/build-contracts.sh`, stripped): **52 584 bytes**, data hash
  `0x8e389ff2fa0c933ba27fa45585f3a4db542c095ef8eb45d784f37252d26ff751` (well under the 120 KB estimate).
  Any later source or dependency change changes this; phase 5 records the final one in `docs/contracts.md`.
- **Every input of the group is checked on the owner path** (SPEC §4: "every input of the group is checked"),
  not only index 0 as the phase note suggests. Reason: anyone can create a cell with lock `crt-node-lock`,
  args `T ‖ R` and arbitrary data; with "index 0 only" an attacker could put such a cell (with their own
  `owner_lock_hash`) at group index 0 next to a real Node Cell and spend both through the owner path. So the
  owner path succeeds only if every group input's `owner_lock_hash` is present among the inputs; each group
  input's data must decode (error 6) before the owner path is evaluated.
- Node path with more than one group input fails with **12** ("require the same count of outputs": the node path
  allows exactly one output, so only a one-input group can match). Error 15 (no runner input) is checked first.
- Rule order inside release follows the SPEC §4.2 table: pubkey unchanged and derived from `privkey` (21), then
  `since` form (8) and value (22), then the Alive Cell dep (23). `node_release_changes_pubkey_rejected` therefore
  yields **21** (pubkey is not in the 11 field list). `deadline + GRACE` overflow → 22 (unreachable deadline).
- Commit check is literal: `in.pubkey` all zero, `out.pubkey[0] ∈ {02, 03}` and not all zero, `out.privkey` all
  zero → else 20. No on-curve check (the spec does not describe one; an invalid point only makes the switch
  unreleasable, which a malicious runner can achieve anyway by forgetting its key).
- Molecule `Script` parsing is strict (header offsets 16/48/49, total size, args length consistent). Own script
  that does not fit 256 bytes or does not parse → 5. Cell deps without a type script (`ItemMissing`) or with a
  type script larger than 128 bytes (cannot have 32-byte args) are skipped for the dep rule.
- Output data / capacity: output data invalid → 6, then capacity (13), then unchanged fields (11) — SPEC order.
  Syscall errors map as in CSR's dual lock: 1 index out of bound, 2 item missing, 3 length not enough, 4 other
  (also used for unexpected field lengths).

### Phase 2 — `crt-core`

- 2026-11-15 — `k256` 0.13 with only `arithmetic` (no ecdsa needed: only scalar → point); `blake2b-ref` 0.3 for
  `ckb-default-hash`. `alloc` feature declared but unused (nothing allocates). Added `ckb_blake2b` helper.
- `TYPE_ID_CODE_HASH` is `0x00…00545950455f4944` (right-aligned ASCII, CKB's real value).
- `since_is_absolute_timestamp` requires the whole flags byte to equal `0x40` (reserved bits rejected).
- `identity_vectors` parses the JSON by hand (no serde dependency) and also checks `job_payload` via `parse_payload`.
- `CoreError` has `Data`, `Payload`, `Key`. Decoding is strict (length 139, version 1, state ≤ 2); pubkey/privkey
  contents are not validated at decode time (the lock does it per state).

### Phase 1 — housekeeping, toolchain, workspace

- 2026-11-15 — Housekeeping verified, nothing to repair: no `*:Zone.Identifier` files, no `crt-spec-repo.tar.gz`,
  no `node/`, `docs/history/{concept-v0.3,node-api-v0.1-draft,spec-v0.1-draft}.md` present, `.gitignore` already
  lists `target/`, `build/`, `node_modules/`, `.refs/`, `.devnet/`, `dist/`. `CHANGELOG.md` already had an
  "Unreleased" section; one line for the workspace was added.
- Toolchain: Rust stable (rustup, minimal profile) and `riscv64imac-unknown-none-elf` were already installed in
  the user's home; `rust-toolchain.toml` at the repository root pins `stable` with that target and the `rustfmt`
  and `clippy` components (the quality gates of `AIWORKER.md` need them). Root rather than `contracts/` so the
  later `service/` workspace shares the pin.
- Workspace `ckb-std` pin is CSR's (`=1.1.0`, `allocator`, `dummy-atomic`) **without** `ckb-types`: phase 3
  forbids it for the lock (the `bytes` crate emits atomics ckb-vm rejects) and no other member uses ckb-std.
- `default-members = ["crt-core", "crt-contract-tests"]`: `crt-node-lock` is `no_std`/`no_main` and cannot be
  built for the host (ckb-std's `entry!` only provides `_start`/panic handler for riscv64), so a plain
  `cargo test` / `cargo clippy --all-targets` in `contracts/` would fail. The lock is built by
  `scripts/build-contracts.sh` (`-p crt-node-lock --target riscv64imac-unknown-none-elf`) and linted with the
  same `--target`. `named.mjs` uses `-p`, unaffected.
- Member crates are created now as compiling stubs so that the workspace resolves and the gates run: `crt-core`
  is an empty `#![no_std]` library (phase 2 adds `k256`/`blake2b-ref`), `crt-contract-tests` an empty library
  (phase 4 adds `ckb-testtool` and `build.rs`), and `crt-node-lock` **fails closed** with exit code 127 (not a
  §4.3 code) so a stub build can never be mistaken for a working lock. Phase 3 replaces it.
- `scripts/build-contracts.sh` is CSR's script with one package and a `data_hash` step: blake2b-256 with
  personalization `ckb-default-hash`, computed with Python's `hashlib` (`python3 -I`), which is on the machine
  and avoids a Rust helper binary; if `python3` is missing the script says so instead of failing. `-C link-arg=-s`
  plus `strip = true` in the release profile as in CSR.
- `contracts/Cargo.lock` is committed (CSR does the same) so `--locked` builds are reproducible; the data hash of
  the stub build is **not** recorded as the code hash (phase 3 records the real one).

## (no spec run yet)

- 2026-11-14 — maintainer: SPEC.md v0.2 (CSR edition) and the specs under `aiworker/` written; vectors in
  `spec/vectors/` generated with an independent Python implementation (blake2b-256 `ckb-default-hash`, GF(2^8)
  Shamir with polynomial 0x11b, JCS as `sort_keys` + compact separators for the integer/string subset).
