# Contracts

One script, `crt-node-lock` (Rust, `no_std`, `ckb-std` 1.1, `hash_type data2`). The normative text is
[`SPEC.md`](../SPEC.md) §3.2 (Node Cell) and §4 (the lock). This page is a map, not a copy.

## Workspace (`contracts/`)

| Crate | Role |
|---|---|
| `crt-core` | shared `no_std` library: `NodeCellData` codec, the rule checks, secp256k1 key derivation (`k256`) |
| `crt-node-lock` | the on-chain binary; loads the group, calls `crt-core` |
| `crt-contract-tests` | `ckb-testtool` harness and the 24 named transaction tests (`tests/node_lock.rs`) |

## Cell layouts

* **Node Cell** (SPEC §3.2): lock `crt-node-lock`, `args = T (32) ‖ R (32)`; data 139 bytes:
  `version u8 | state u8 | deadline u64 LE | owner_lock_hash 32 | descriptor_hash 32 | pubkey 33 | privkey 32`.
  Capacity 244 CKB.
* **Alive Cell** (SPEC §3.1): immutable, type-id script with `args = T`; its liveness is what permits release.

## The two paths

* **Owner path** (SPEC §4.1): any input whose lock hash equals `owner_lock_hash` → everything is allowed.
* **Node path** (SPEC §4.2): an input locked by `R` (the CSR runner wallet cell) must be present, exactly one
  output keeps the lock, and only the transitions *commit* (0 → 1, pubkey set) and *release* (1 → 2, privkey
  set, `since` ≥ `deadline + GRACE`, live Alive Cell as cell dep) are allowed. State 2 is final.

## Error codes

See [`SPEC.md` §4.3](../SPEC.md#43-error-codes) (5, 6, 8, 11, 12, 13, 15, 20–24; 1–4 are syscall failures).
Rules are checked in the order of §4.2, which fixes the code a malformed transaction gets (for example, a
release that swaps the key pair fails with 21, not 11).

## Build

```sh
scripts/build-contracts.sh          # release build; prints size and data hash
cd contracts && CARGO_BUILD_JOBS=2 cargo test    # unit and contract tests (builds the binary if missing)
```

Needs `rustup` with the stable toolchain and target `riscv64imac-unknown-none-elf` (see
`rust-toolchain.toml`). `contracts/Cargo.lock` is committed; builds use `--locked`.

## Measured

* Cycles: a release transaction (Node Cell + runner wallet input, Alive Cell dep) takes **2 298 371 cycles**;
  the script budget is 60 M, the verifier limit 70 M.
* Size: 52 584 bytes (stripped release build).
* Data hash of the release build (blake2b-256, `ckb-default-hash`), the `code_hash` clients pin with `data2`:

  `0x8e389ff2fa0c933ba27fa45585f3a4db542c095ef8eb45d784f37252d26ff751`

  The data hash changes with any source, dependency or toolchain change; re-run the build script and update
  this page and `deployments/` together.
