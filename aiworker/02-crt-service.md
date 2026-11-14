# Spec 02 — the CRT service for CSR (`crt-service`)

**Branch:** `aiworker/crt-service`. **Acceptance:** `acceptance/aiworker-crt-service/`.
**Depends on:** CSR ≥ 0.6.1 (`random_bytes`), spec 01 (`crt-core`).
**Normative:** `SPEC.md` §5, §6, §14. **Model to copy:** `.refs/csr/services/rust/*` (workspace,
`csr-svc` syscall wrappers, manifests), `spec/host-interface.md`.

## Phase 1 — host bindings

`service/Cargo.toml` workspace (`crt-host`, `crt-service`), same `ckb-std` pin and release profile as CSR's
`services/rust`. `rust-toolchain.toml` as in `contracts/`.

`service/crt-host`: `no_std` wrappers for every host call the service uses, in the style of CSR's `csr-svc`
(copy its conventions, not its file: this repository must not depend on a path outside itself at build time):
`job_payload`, `block_info`, `chain_read`, `cells_query`, `kv_get`, `kv_put`, `kv_delete`, `kv_mark_secret`,
`delete_on_consume`, `random_bytes` (7050), `tx_skeleton_put`, `result_put`, plus `load_script_args` (CKB
`load_script` → molecule `Script`, hand-parsed, returns the args) and `load_cell_data` of cell dep 1 (the
deployment data cell, `SPEC.md` §5.5). Each wrapper returns the raw code; buffer-out calls follow the partial
loading convention. A `trait Host` with these methods and two implementations: `Syscalls` (real) and, under
`cfg(test)` / feature `mock`, `MockHost` (in-memory kv, scripted chain, fixed block info, deterministic "random"
bytes, records the skeleton and the result). The mock is what the state-machine tests run against.

## Phase 2 — the state machine

`service/crt-service/src/machine.rs`: a pure function
`fn step(host: &mut impl Host, deployment: &CrtDeployment) -> Outcome` implementing `SPEC.md` §5.3 verbatim, with
`Outcome { status: u8, skeleton: Option<Skeleton> }` and the status codes of §5.3. Key points:

* `I = crt_core::identity(deployment.network_id, T)`; `kv` key = `I` (32 bytes).
* KEYGEN draws `random_bytes(32)`; if the scalar is 0 or ≥ n, draw again (at most 8 times, then status `key_lost`
  with no kv write — practically unreachable). Store **before** building the skeleton; `kv_mark_secret`;
  `delete_on_consume(I, alive_outpoint)`.
* Never call `kv_put` when `kv_get(I)` succeeded.
* `cells_query` scripts: type-id type script with args `T` (`script_type = 1`); `crt-node-lock` lock script
  (`code_hash = deployment.node_lock_code_hash`, `hash_type = data2 (2)`, `args = T ‖ R`, `script_type = 0`).
  More than one Alive Cell for `T` is impossible; more than one Node Cell for `T ‖ R` → take index 0 and set
  status `bad_payload` if their data disagree (log in `DECISIONS.md` why this cannot happen).
* **Skeleton** (`tx_skeleton_put`, molecule `Transaction` built by hand, as `csr-svc` has no builder): inputs
  `[Node Cell out point with since]`, outputs `[Node Cell: same lock, same capacity, new data]`, cell deps
  `[crt-node-lock code cell (deployment.node_lock_outpoint, dep_type code)]` plus, on release, `[Alive Cell out
  point, dep_type code]`. Witnesses: one empty witness for the input (the lock needs none). Raw transaction
  `version 0`, no header deps.
* Result: `"CRT1" ‖ status ‖ T` (37 bytes) always, even for `bad_args`.
* Exit code 0 always (a non-zero exit is counted as a service failure by CSR and after 3 failures the job is
  skipped — a HOLD must never look like a failure).

Unit tests (`cargo test -p crt-service --features mock`), names fixed:
`hold_before_deadline`, `keygen_stores_key_and_commits`, `keygen_sets_delete_on_consume_on_alive_cell`,
`keygen_marks_secret`, `recommit_reuses_stored_key`, `recommit_never_regenerates`,
`release_at_deadline_plus_grace`, `release_not_one_second_early`, `release_skeleton_has_alive_dep_and_since`,
`done_deletes_key`, `cancelled_deletes_key_and_empty_skeleton`, `dropped_deletes_key`,
`key_lost_reports_without_skeleton`, `bad_payload_reports`, `bad_args_reports`, `result_format_is_crt1_status_t`,
`skeleton_capacity_unchanged`, `skeleton_molecule_decodes` (decode the produced skeleton with `ckb-types` in the
test to prove it is a valid molecule `Transaction`).

## Phase 3 — the binary, manifest and enable script

1. `service/crt-service/src/main.rs`: `ckb_std::entry!`, `default_alloc!`, read the deployment data cell (cell dep
   index 1 of the virtual transaction, `load_cell_data(1, Source::CellDep)`), call `step`, exit 0.
2. `scripts/build-service.sh`: builds `crt-service` for `riscv64imac-unknown-none-elf`, copies to
   `service/build/crt-service.elf`, prints its data hash (`CRT_CODE_HASH`).
3. `service/manifests/crt-local.toml.in`: template of the local manifest (`SPEC.md` §5.1) with `@R@` and the data
   cell reference as CSR's local manifest format allows (if local manifests cannot name a data cell — check
   `runtime/manifest.rs` in the CSR checkout — then in local mode the deployment constants are read from a
   second entry: document the finding in `DECISIONS.md` and implement what the format supports; the on-chain
   manifest always uses the data cell).
4. `scripts/crt-enable.sh`: operator script (`docs/operators.md`). Steps: locate `csr` (`PATH`, `/usr/local/bin`);
   read the runner lock hash `R` (`csr identity --json` if it prints a lock hash; else compute
   `blake2b256(Script{secp256k1_blake160, type, args = blake160(service_pubkey)})` from the identity output —
   implement whichever works against CSR 0.6.x and record it); download the release `crt-service.elf` for the
   runner's version (GitHub release asset, SHA256 checked against `SHA256SUMS` in the release) or use a local
   path; render the manifest; `csr service add-local --manifest …`, `approve`, `enable`; print the **CRT service
   ID** computed per `spec/service-manifest.md` §4 (composite: code hash, args `R`, one data hash); print the
   dashboard URL to check. `--network testnet|mainnet`, `--dry-run`. Idempotent (re-run = no-op).
5. `scripts/crt-disable.sh`: `csr service disable` + `revoke`; prints that stored keys stay until the Alive Cells
   die (the host rule) and how to delete them by hand if the operator insists (`csr storage …`).

## Phase 4 — devnet smoke test (no judge dependency)

`scripts/devnet-service-smoke.sh` using CSR's `scripts/devnet.sh` and `csr-dev`: deploy `crt-node-lock` and the
deployment data cell; publish the generic manifest; register a devnet runner; create one switch by hand with
`csr-dev` or a Node script (`client/` may not exist yet: use a minimal Node script under `scripts/devnet/` with
`csr-job.mjs` copied from the CSR checkout and plain JSON-RPC); watch the Node Cell reach state 1; advance the
devnet clock past `deadline + GRACE` (devnet median time: mine blocks with timestamps as `csr-dev` allows) and
watch state 2; consume the Alive Cell on a second switch and check `service_data/deletions.log`. Print PASS/FAIL per
step. This script is **not** run by the acceptance tests (they have no devnet); its PASS output is pasted into
`DECISIONS.md`.

## Phase 5 — documentation

`docs/operators.md` (exists; fill the "Enable" section with the real commands and the output to expect, the cost
table from `SPEC.md` §11, what the Jobs page shows per status byte), `docs/service.md` (state machine diagram as
text, the result format, cycle numbers from the smoke test), `CHANGELOG.md`, `README.md` rows for `service/` and
`scripts/`.

## Acceptance

```sh
node --test acceptance/aiworker-crt-service/
node acceptance/aiworker-crt-service/named.mjs
```
