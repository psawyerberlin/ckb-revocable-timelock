# AI worker run — `crt-core` and `crt-node-lock`

You are an autonomous coding agent working alone in the repository `psawyerberlin/ckb-revocable-timelock`. Nobody will answer questions;
decide, record, continue. Do not stop before every phase below is done or recorded as blocked.

## Start

1. `cd` into the repository root. Read, in this order and completely: `AIWORKER.md`, `SPEC.md`,
   `aiworker/01-crt-contracts.md`, `spec/vectors/identity.json`, and in `../ckb-service-runner`: `contracts/Cargo.toml`, `contracts/csr-job-lock/` (a lock script that already uses `k256` in CKB-VM — copy its approach), `contracts/csr-contract-tests/`, `scripts/build-contracts.sh`, then `DECISIONS.md` (a previous run may have left notes for you).
2. Create the branch `aiworker/crt-contracts` from the current `main` (if it exists already, continue on it).
3. Run the acceptance command once before writing any code, to see what is expected:

```sh
node --test acceptance/aiworker-crt-contracts/
node acceptance/aiworker-crt-contracts/named.mjs
```

## Do

Work through the phases of `aiworker/01-crt-contracts.md` in order:

1. Phase 1 — verify housekeeping, create the `contracts/` workspace, `scripts/build-contracts.sh`, `.gitignore`, `CHANGELOG.md`.
2. Phase 2 — `contracts/crt-core` (`no_std`, no `ckb-std`): layouts, identity, payload, `k256` pubkey derivation, `since` helpers; tests with the fixed names, vectors read from `spec/vectors/`.
3. Phase 3 — `contracts/crt-node-lock`: owner path, node path, commit and release rules, error codes of SPEC §4.3; record size and data hash.
4. Phase 4 — `contracts/crt-contract-tests` with `ckb-testtool`: every test name of the spec table, including `cycles_release_under_budget` printing the cycle count.
5. Phase 5 — `docs/contracts.md`, README rows, CHANGELOG.

After each phase: quality gates of `AIWORKER.md` §3.4, the acceptance command above, a commit
(`type(scope): summary`), and a bullet per decision in `DECISIONS.md` under a `## crt-contracts` section (newest spec
first in the file).

## Rules that override everything else

- Protected paths (`AIWORKER.md` §3.2) are never edited: `acceptance/**`, `SPEC.md`, `AIWORKER.md`, `aiworker/**`
  and the others listed there. A test you disagree with is implemented as written and the disagreement is noted.
- No manual steps. Anything only a human can do goes into `docs/manual-steps.md` as exact commands, and you continue.
- No secrets, no funded keys, no tokens in the repository.
- Never fake a passing test. A blocked phase stays red and is explained in `DECISIONS.md`.
- The release path's cell-dep check looks only at the dep's type script fields (type-id code hash, hash type `type`, args `T`); ckb-testtool need not execute type-id for a dep.
- Keep `crt-core` free of `ckb-std` so the service and the TypeScript tests can share its vectors.

## Finish

Push the branch and open one pull request against `main` using `.github/pull_request_template.md`: phases done,
the acceptance output (last 30 lines), the `DECISIONS.md` section, and any `SPEC.md` change you propose as a
diff in the body. Then stop.
