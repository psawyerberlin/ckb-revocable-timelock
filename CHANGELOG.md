# Changelog

## Unreleased

- `crt-service` (`service/`): CSR service with host bindings, mock host and the SPEC §5.3 state machine; `scripts/build-service.sh`,
  `crt-enable.sh`, `crt-disable.sh`, `devnet-service-smoke.sh` (written, not run); `docs/service.md`, filled `docs/operators.md`.
- `crt-node-lock` contract with `crt-core` and 24 contract tests; `docs/contracts.md` (layouts, paths, cycles, data hash).
- `contracts/` Rust workspace (`crt-core`, `crt-node-lock`, `crt-contract-tests`), `rust-toolchain.toml`
  and `scripts/build-contracts.sh` (release build, size and data hash of `crt-node-lock`).
- SPEC.md v0.2 (CSR edition): CRT built on CKB Service Runner; Alive Cell immutable, Node Cell per runner,
  `crt-node-lock`, CRT service state machine, heartbeat jobs, `CRT/v1` prefix, 24 h grace.
- AI worker specs 00–05 and their acceptance tests.
- Explainer site under `site/`.
