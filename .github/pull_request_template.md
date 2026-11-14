## What and why

Spec: `aiworker/NN-….md`, phases done: 

## How tested

- [ ] `node --test acceptance/aiworker-<name>/` and `node acceptance/aiworker-<name>/named.mjs` green
- [ ] `cargo fmt --check` / `cargo clippy --all-targets -- -D warnings` / `cargo test` (if Rust changed)
- [ ] `npm test` (if TypeScript changed)
- [ ] devnet scenario output pasted into `DECISIONS.md` (spec 05)

## Decisions

See `DECISIONS.md` section for this spec. Proposed `SPEC.md` changes (the worker cannot edit it):

## Security-sensitive?

- [ ] touches `contracts/` or `service/` (needs two reviews)
