# Spec 00 — `random_bytes` host call for CSR (`csr-random-bytes`)

**Runs in:** the `ckb-service-runner` repository (branch `aiworker/csr-random-bytes`).
**Acceptance:** `acceptance/aiworker-csr-random-bytes/` — copy that directory from this repository into the CSR
checkout before starting (it is protected there too).
**Why:** CRT services must generate fresh secp256k1 keys inside the sandbox from a cryptographic RNG
(`SPEC.md` §5.3, §14). `spec/host-interface.md` lists 7050 `random_bytes` as reserved (returns 2). This spec
implements it. Nothing else in CSR changes.

## Phase 1 — host call

Deliverables:

1. `random_bytes(addr, len)` = syscall **7050**, arguments `a0 = addr`, `a1 = len`. The host fills `len` bytes at
   `addr` in VM memory from the operating system's CSPRNG (`rand::rngs::OsRng` via the `rand` crate already in the
   dependency tree, or `getrandom`; add a `DECISIONS.md` line naming which). Returns in `a0`:
   `0` success; `11` (`too large`) when `len > 1024`; `12` (`invalid argument`) when `len == 0`. A VM memory
   error (unwritable address) stops the run like any other memory fault.
2. **Available in every mode**, including `csr service run-local` (unlike the chain calls): the local mode is
   where service developers test keygen.
3. **Cycle cost** as for every syscall: 500 + ⌈len / 4⌉ cycles.
4. **Never logged.** The bytes do not appear in debug output, logs or the database. Add a unit test that the
   `debug` capture of a run calling `random_bytes` contains no hex of the returned bytes (the test service of
   phase 2 writes them to `result_put`, not to `debug`).
5. `spec/host-interface.md`: replace the reserved row for 7050 with the definition above; keep 7051
   `prekey_decrypt` reserved. Update the RFC draft `docs/rfc/0000-ckb-vm-host-interface.md` only in its table of
   calls (the spec wins). Remove the line "CRT: prekey support (`prekey_decrypt`, `random_bytes`) is reserved…"
   from `docs/open-questions.md` and replace it with "CRT: `prekey_decrypt` (7051) stays reserved; `random_bytes`
   shipped in <version>".
6. `CHANGELOG.md`: an "Unreleased" entry "host interface: `random_bytes` (7050)".

Rules: no change to the syscall numbering of anything else; no new feature flag; `cargo clippy -D warnings`.

## Phase 2 — test service and docs

1. `services/rust/randtest`: a service that calls `random_bytes(32)` twice into two buffers, then
   `result_put(b1 ‖ b2 ‖ status_bytes)` where `status_bytes` are the two return codes, and additionally calls
   `random_bytes` with `len = 1025` and `len = 0` and appends those two return codes (expected `11`, `12`). Add
   `services/manifests/randtest.toml` and the crate to the `services/rust` workspace. `scripts/build-services.sh`
   builds it like the others.
2. A runner integration test (same pattern as the existing `kvtest` / `signtest` tests) that runs `randtest` in
   local mode and asserts: result length 64 + 4, the two 32-byte halves differ, neither is all zeros, codes
   `0 0 11 12`.
3. `docs/testing.md`: one line on `randtest`. `README.md` ("Services in a RISC-V sandbox") mentions the CSPRNG
   call in its one-sentence list of what the host interface offers.

## Acceptance

From the CSR repository root:

```sh
node --test acceptance/aiworker-csr-random-bytes/
node acceptance/aiworker-csr-random-bytes/named.mjs
```

`named.mjs` runs `cargo test -p csr random_bytes` (tests named `random_bytes_fills_len`, `random_bytes_len_zero_is_12`,
`random_bytes_len_over_1024_is_11`, `random_bytes_local_mode_works`, `random_bytes_never_in_debug`) and the
`randtest` integration test `randtest_two_draws_differ`. The worker names its tests exactly so.

## Out of scope (do not do)

`prekey_decrypt`; a confirmation depth for `delete_on_consume` (proposed in `SPEC.md` §14, separate spec);
`csr service add-onchain --args`.
