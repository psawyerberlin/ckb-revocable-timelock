# Decisions log (AI worker)

Newest spec first. One `##` section per spec, one bullet per decision: what was unspecified or contradictory,
what was chosen and why. Protocol-changing decisions are also proposed as a `SPEC.md` diff in the PR body
(`AIWORKER.md` §5).

## Spec 03 — `crt-client` (`aiworker/03-crt-client.md`)

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

### Phase 2 — chain access

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

### Phase 1 — primitives

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
