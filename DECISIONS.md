# Decisions log (AI worker)

Newest spec first. One `##` section per spec, one bullet per decision: what was unspecified or contradictory,
what was chosen and why. Protocol-changing decisions are also proposed as a `SPEC.md` diff in the PR body
(`AIWORKER.md` §5).

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
