# Spec 01 — `crt-core` and `crt-node-lock` (`crt-contracts`)

**Branch:** `aiworker/crt-contracts`. **Acceptance:** `acceptance/aiworker-crt-contracts/`.
**Normative:** `SPEC.md` §2, §3.1–3.2, §4, §13. **Model to copy:** `.refs/csr/contracts/` (workspace
layout, `build-contracts.sh`, `csr-contract-tests` with `ckb-testtool`, hand-parsed data, `k256` 0.13 no_std).

## Phase 1 — repository housekeeping and workspace

1. Housekeeping was done by the maintainer (no `*:Zone.Identifier` files, no `crt-spec-repo.tar.gz`, v0.1-draft
   documents under `docs/history/`, `node/` removed, `coordinator/README.md` kept as the v0.2 item). Verify it
   (`acceptance/aiworker-crt-contracts/wiring.test.mjs`, "phase 1") and repair whatever a rebase may have brought
   back. `README.md`, `SPEC.md` and `docs/` are already updated; do not rewrite them in this phase beyond the rows
   listed in phase 5.
2. `contracts/Cargo.toml` workspace with members `crt-core`, `crt-node-lock`, `crt-contract-tests`; the release
   profile and `ckb-std` pin of CSR's workspace. `rust-toolchain.toml` pinning stable with the `riscv64imac-unknown-none-elf`
   target. `.gitignore` for `target/`, `build/`, `.devnet/`, `node_modules/`.
3. `scripts/build-contracts.sh`: same shape as CSR's; output `contracts/build/release/crt-node-lock`; prints the
   size and the **data hash** (blake2b-256, `ckb-default-hash`) of the binary, which is the `code_hash`
   clients pin.
4. `CHANGELOG.md` with an "Unreleased" section.

## Phase 2 — `contracts/crt-core` (`no_std`, no `ckb-std` dependency)

Pure library used by the lock, the service and the tests. `#![no_std]`, `alloc` optional behind a feature,
no I/O.

```rust
pub const PREFIX_CELL: &[u8]       = b"CRT/v1/cell";
pub const PREFIX_SHARE: &[u8]      = b"CRT/v1/share";
pub const PREFIX_DESCRIPTOR: &[u8] = b"CRT/v1/descriptor";
pub const GRACE_SECONDS: u64       = 86_400;
pub const PAYLOAD_MAGIC: &[u8; 4]  = b"CRTS";
pub const PAYLOAD_VERSION: u8      = 1;
pub const ALIVE_CELL_DATA: [u8; 4] = [0x43, 0x52, 0x54, 0x01];
pub const NODE_CELL_DATA_LEN: usize = 139;
pub const TYPE_ID_CODE_HASH: [u8; 32] = …545950455f4944;   // hash_type type

pub struct NodeCellData { pub version: u8, pub state: u8, pub deadline: u64, pub owner_lock_hash: [u8;32],
                          pub descriptor_hash: [u8;32], pub pubkey: [u8;33], pub privkey: [u8;32] }
impl NodeCellData { pub fn decode(&[u8]) -> Result<Self, CoreError>;  pub fn encode(&self) -> [u8; 139]; }

pub fn identity(network_id: u8, type_id: &[u8;32]) -> [u8;32];          // blake2b256(PREFIX_CELL ‖ net ‖ T)
pub fn parse_payload(&[u8]) -> Result<[u8;32], CoreError>;              // "CRTS" ‖ 1 ‖ T → T
pub fn pubkey_from_privkey(d: &[u8;32]) -> Result<[u8;33], CoreError>;  // k256, compressed; Err on 0 or ≥ n
pub fn is_valid_compressed_pubkey(p: &[u8;33]) -> bool;                 // prefix 02/03 and on curve
pub fn since_absolute_timestamp(seconds: u64) -> u64;                   // 0x4000_0000_0000_0000 | seconds
pub fn since_is_absolute_timestamp(since: u64) -> Option<u64>;          // Some(seconds) iff flags == 0x40 and metric bits only
```

`blake2b-ref` for hashing. Decoding is strict: exact length 139, `version == 1`, `state ≤ 2`; everything else
`CoreError::Data`. Tests (host, `cargo test -p crt-core`), names fixed: `node_cell_roundtrip`;
`identity_vectors` — the five vectors of `spec/vectors/identity.json` (read at test time from the repository
via `CARGO_MANIFEST_DIR`; the file is protected); `since_encoding` against the CKB RFC 17 flag layout;
`pubkey_of_one_is_generator` (`pubkey_from_privkey(1) == 0x0279be667e…f81798`); `rejects_zero_and_n`.

## Phase 3 — `contracts/crt-node-lock`

`ckb-std` 1.1.0 (`allocator`, `dummy-atomic`; no `ckb-types`), `hash_type data2`. Implements `SPEC.md` §4 exactly,
with the error codes of §4.3. Notes:

* **Owner path:** iterate inputs (`load_cell_by_field(LockHash, Source::Input)`) until one equals
  `owner_lock_hash` of **this** cell's data (`Source::GroupInput`, index 0); the lock reads its own input's data
  with `load_cell_data(GroupInput, 0)`. Several Node Cells of one switch in one owner transaction are each their
  own group only if their args differ — they do (`R` differs), so each group has one input. If a group ever has
  two inputs (same `T ‖ R`, should not exist), process index 0 only and require the same count of outputs (error
  12).
* **Node path:** find the input with lock hash `R` (`args[32..64]`); find outputs whose lock script hash equals
  this group's script hash (`load_script_hash` vs `load_cell_by_field(LockHash, Output)`); exactly one (error 12).
* **Release:** `load_input_by_field(Since, GroupInput, 0)`; `since_is_absolute_timestamp` else 8; value ≥
  `deadline + GRACE_SECONDS` else 22. Alive Cell dep: iterate `Source::CellDep` with
  `load_cell_by_field(Type)`; a dep whose type script is `code_hash == TYPE_ID_CODE_HASH`, `hash_type == type`
  (byte 1), `args == T` exists, else 23. `pubkey_from_privkey(out.privkey) == in.pubkey` else 21.
* Compile with `-C link-arg=-s`; expected size < 120 KB. Record the real size and the data hash in
  `DECISIONS.md`.

## Phase 4 — `contracts/crt-contract-tests` (`ckb-testtool` 1.1.x)

Harness like CSR's: deploy the built lock from `contracts/build/release/` (a `build.rs` that runs
`scripts/build-contracts.sh` when the binary is missing, as CSR does), a fake type-id script (any always-success
script deployed with `hash_type type`? — **no**: use the real type-id semantics only in the arg check; for the dep
rule the tests build a dep cell whose type script has `code_hash = TYPE_ID_CODE_HASH`, `hash_type = type`, `args =
T` and an always-success *lock*; ckb-testtool does not run type-id for deps, which is fine, the lock only looks at
the script fields), an always-success lock standing in for the owner and for the runner wallet.

Test names are **fixed** (the acceptance script runs them by name):

| Test | Expectation |
|---|---|
| `owner_can_update_deadline` | owner input present, deadline changes → ok |
| `owner_can_write_descriptor_hash` | ok |
| `owner_can_destroy` | input, no output → ok |
| `node_commit_ok` | state 0→1, runner input, pubkey valid → ok |
| `node_commit_without_runner_input_rejected` | 15 |
| `node_commit_two_outputs_rejected` | 12 |
| `node_commit_zero_pubkey_rejected` | 20 |
| `node_commit_with_privkey_rejected` | 20 |
| `node_commit_changing_deadline_rejected` | 11 |
| `node_commit_lower_capacity_rejected` | 13 |
| `node_release_ok` | state 1→2, since = 0x40‖(deadline+86400), Alive dep, pubkey(d)=P → ok |
| `node_release_wrong_privkey_rejected` | 21 |
| `node_release_early_since_rejected` | 22 (since = deadline + 86399) |
| `node_release_block_since_rejected` | 8 (absolute block flags) |
| `node_release_relative_timestamp_rejected` | 8 (0xc0 flags) |
| `node_release_without_alive_dep_rejected` | 23 |
| `node_release_alive_dep_wrong_args_rejected` | 23 |
| `node_release_changes_pubkey_rejected` | 11 or 21 (document which) |
| `node_release_from_state0_rejected` | 24 |
| `node_state2_to_anything_rejected` | 24 |
| `bad_args_length_rejected` | 5 |
| `bad_data_length_rejected` | 6 |
| `cycles_release_under_budget` | release tx verifies under **60 M cycles**; print the number |

Also a `vectors_identity_matches` test in this crate re-checking `spec/vectors/identity.json` through `crt-core`.

## Phase 5 — documentation

`docs/contracts.md`: one page — cell layouts, the two paths, error table (reference `SPEC.md` §4.3 rather than
copying), how to build, the measured cycles, the data hash of the release build. `CHANGELOG.md` entry.
`README.md` "Repository layout" rows for `contracts/`.

## Acceptance

```sh
node --test acceptance/aiworker-crt-contracts/
node acceptance/aiworker-crt-contracts/named.mjs
```
