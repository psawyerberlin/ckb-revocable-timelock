# The CRT service (runs inside CSR)

Source: `service/` (`crt-host`: host-call bindings and `MockHost`; `crt-service`: state machine and binary).
Normative behaviour: `SPEC.md` §5.3. Operators: [`operators.md`](operators.md).

## Per-run state machine

Each job run reads the payload (`"CRTS" ‖ 0x01 ‖ T`), looks up the Alive Cell for `T` and this runner's Node Cell,
and takes exactly one branch. Time is only ever the block median time from `block_info`; there is no wall clock.

```text
args are not 32 bytes ───────────────────────────────────────► 08 bad_args
payload malformed ───────────────────────────────────────────► 09 bad_payload
Alive Cell (type-id T) not live ─► delete key ───────────────► 05 cancelled   (no skeleton)
no Node Cell for (T, R) ─► delete key ───────────────────────► 06 dropped     (no skeleton)
Node Cell state 0 (fresh):
    key stored ─────────────────────────────────────────────► 02 recommit    (same key, never regenerated)
    no key: random_bytes → d, kv_put, kv_mark_secret,
            delete_on_consume(d, Alive Cell) ───────────────► 01 keygen
    (both: commit skeleton, state 1, pubkey P in cell data)
    stored key wrong length / keygen failed ────────────────► 07 key_lost
Node Cell state 1 (committed):
    no usable stored key ───────────────────────────────────► 07 key_lost    (no skeleton)
    median_time < deadline + GRACE_SECONDS ─────────────────► 00 hold        (no skeleton)
    pubkey(d) != committed P ───────────────────────────────► 07 key_lost
    otherwise: release skeleton (Alive Cell as cell dep,
               since = deadline + GRACE, d in cell data) ───► 03 release
Node Cell state 2 (released) ─► delete key ──────────────────► 04 done        (no skeleton)
```

See `machine.rs` for the authoritative order of the checks; the 18 unit tests in that file (run by
`node acceptance/aiworker-crt-service/named.mjs`) pin every branch.

## Result format

37 bytes: `"CRT1"` (4) ‖ status (1) ‖ `T` (32). Status bytes are `00`–`09` as listed in `operators.md`. The result is
written on every run, including when no skeleton is produced.

## Cycle numbers

Not measured yet: the devnet smoke script (`scripts/devnet-service-smoke.sh`) was written and statically checked
but not run in the authoring environment, so no cycle counts exist. They will be recorded here after the manual
devnet phase.

## Build and test

```sh
scripts/build-service.sh                       # service/build/crt-service.elf + CRT_CODE_HASH
cargo test --manifest-path service/Cargo.toml -p crt-service --features mock
```
