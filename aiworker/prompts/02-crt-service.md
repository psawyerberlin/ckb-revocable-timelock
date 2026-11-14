# AI worker run — the CRT service for CSR

You are an autonomous coding agent working alone in the repository `psawyerberlin/ckb-revocable-timelock`. Nobody will answer questions;
decide, record, continue. Do not stop before every phase below is done or recorded as blocked.

## Start

1. `cd` into the repository root. Read, in this order and completely: `AIWORKER.md`, `SPEC.md`,
   `aiworker/02-crt-service.md`, `docs/operators.md`, and in `../ckb-service-runner`: `spec/host-interface.md`, `spec/service-manifest.md` §4, `services/rust/csr-svc/src/lib.rs`, `services/rust/kvtest/`, `services/manifests/*.toml`, `runner/src/runtime/manifest.rs`, `docs/publishing-a-service.md`, `docs/testing.md`, then `DECISIONS.md` (a previous run may have left notes for you).
2. Create the branch `aiworker/crt-service` from the current `main` (if it exists already, continue on it).
3. Run the acceptance command once before writing any code, to see what is expected:

```sh
node --test acceptance/aiworker-crt-service/
node acceptance/aiworker-crt-service/named.mjs
```

## Do

Work through the phases of `aiworker/02-crt-service.md` in order:

1. Phase 1 — `service/` workspace, `crt-host` syscall wrappers (including 7050 `random_bytes`), `trait Host`, `MockHost`.
2. Phase 2 — `machine.rs` implementing SPEC §5.3 exactly; hand-built molecule `Transaction` skeleton; the 18 named tests.
3. Phase 3 — binary, `scripts/build-service.sh`, local manifest template, `scripts/crt-enable.sh` and `crt-disable.sh` (idempotent, `--dry-run`, SHA-256 check, prints the CRT service ID).
4. Phase 4 — `scripts/devnet-service-smoke.sh` against CSR's devnet; paste its PASS/FAIL table into `DECISIONS.md`.
5. Phase 5 — `docs/operators.md` (enable section with real output), `docs/service.md`, CHANGELOG, README rows.

After each phase: quality gates of `AIWORKER.md` §3.4, the acceptance command above, a commit
(`type(scope): summary`), and a bullet per decision in `DECISIONS.md` under a `## crt-service` section (newest spec
first in the file).

## Rules that override everything else

- Protected paths (`AIWORKER.md` §3.2) are never edited: `acceptance/**`, `SPEC.md`, `AIWORKER.md`, `aiworker/**`
  and the others listed there. A test you disagree with is implemented as written and the disagreement is noted.
- No manual steps. Anything only a human can do goes into `docs/manual-steps.md` as exact commands, and you continue.
- No secrets, no funded keys, no tokens in the repository.
- Never fake a passing test. A blocked phase stays red and is explained in `DECISIONS.md`.
- `random_bytes` requires the CSR build from spec 00; if `../ckb-service-runner` lacks it, build that branch first (`cargo build --release` there) and note the commit in `DECISIONS.md`.
- A service exit code other than 0 counts as a failure in CSR; HOLD must exit 0 with an empty skeleton.
- Find out whether CSR local manifests can name a data cell; implement what the format supports and record it.

## Finish

Push the branch and open one pull request against `main` using `.github/pull_request_template.md`: phases done,
the acceptance output (last 30 lines), the `DECISIONS.md` section, and any `SPEC.md` change you propose as a
diff in the body. Then stop.
