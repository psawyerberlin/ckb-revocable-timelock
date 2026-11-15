# Decisions log (AI worker)

Newest spec first. One `##` section per spec, one bullet per decision: what was unspecified or contradictory,
what was chosen and why. Protocol-changing decisions are also proposed as a `SPEC.md` diff in the PR body
(`AIWORKER.md` §5).

## Spec 02 — `crt-service` (`aiworker/02-crt-service.md`)

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
