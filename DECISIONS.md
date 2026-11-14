# Decisions log (AI worker)

Newest spec first. One `##` section per spec, one bullet per decision: what was unspecified or contradictory,
what was chosen and why. Protocol-changing decisions are also proposed as a `SPEC.md` diff in the PR body
(`AIWORKER.md` §5).

## Spec 01 — `crt-contracts` (`aiworker/01-crt-contracts.md`)

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
