# Changelog

## Unreleased

- Rehearsal deployment for testnet: `drill` feature (crt-core, crt-node-lock, crt-service, contract tests) with
  `GRACE` 600 s; `CRT_DRILL=1` in the build scripts; `deploy-testnet.sh --drill` writes `deployments/testnet-drill.json`
  (`grace_seconds`, `drill`); `crt-publish.sh` / `crt-enable.sh --deployment testnet-drill`. The client reads the grace
  from the deployment (`graceSeconds`, heartbeat jobs cover deadline + grace) and refuses another grace or `drill` on
  mainnet. The normal deployments and binaries are unchanged.
- `@crt/client` packaging: the build copies `vendor/csr-job.mjs` into `dist/vendor/` and checks that the built entry
  loads; `main`/`types`/`exports` point at `dist/src/` where `tsc` writes them. Before, `dist/` could not be imported.
- `@crt/client`: minimum term 30 minutes on testnet and devnet (client check, like `n`; mainnet keeps 1 day) for short
  rehearsals such as the dead-man-switch fire drill; Arm and Renew validate with the deployment's network. `GRACE` stays 24 h.
- `deployments/testnet-runners.json`: first entry (pswsl).

- `crt-web` (`web/`), phases 1–4: Vite app at `/app/` with network switch and CCC wallet; create flow Deadline → Runners → Quote →
  Create → Arm → Kit (duration risk, runner directory and coalition summary, live cost quote, hard-fail verification, kit download); My switches and Recover; vitest suite, external-reference check, `docs/web.md`.

- `@crt/client` (`client/`): primitives, chain access, transaction builders, descriptor, recovery kit and recovery, and the
  `crt` command line (`runners`, `plan`, `create`, `status`, `arm`, `renew`, `cancel`, `kit`, `recover`); `client/README.md`,
  integration walkthrough in `docs/developers.md`.
- `crt-service` (`service/`): CSR service with host bindings, mock host and the SPEC §5.3 state machine; `scripts/build-service.sh`,
  `crt-enable.sh`, `crt-disable.sh`, `devnet-service-smoke.sh` (written, not run); `docs/service.md`, filled `docs/operators.md`.
- `crt-node-lock` contract with `crt-core` and 24 contract tests; `docs/contracts.md` (layouts, paths, cycles, data hash).
- `contracts/` Rust workspace (`crt-core`, `crt-node-lock`, `crt-contract-tests`), `rust-toolchain.toml`
  and `scripts/build-contracts.sh` (release build, size and data hash of `crt-node-lock`).
- SPEC.md v0.2 (CSR edition): CRT built on CKB Service Runner; Alive Cell immutable, Node Cell per runner,
  `crt-node-lock`, CRT service state machine, heartbeat jobs, `CRT/v1` prefix, 24 h grace.
- AI worker specs 00–05 and their acceptance tests.
- Explainer site under `site/`.
