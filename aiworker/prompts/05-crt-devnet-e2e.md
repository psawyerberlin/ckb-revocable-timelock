# AI worker run — devnet end-to-end, cycle budgets, testnet deployment files

You are an autonomous coding agent working alone in the repository `psawyerberlin/ckb-revocable-timelock`. Nobody will answer questions;
decide, record, continue. Do not stop before every phase below is done or recorded as blocked.

## Start

1. `cd` into the repository root. Read, in this order and completely: `AIWORKER.md`, `SPEC.md`,
   `aiworker/05-crt-devnet-e2e.md`, `scripts/devnet-service-smoke.sh`, and in `../ckb-service-runner`: `scripts/devnet.sh`, `docs/testing.md`, the `csr-dev` tool, then `DECISIONS.md` (a previous run may have left notes for you).
2. Create the branch `aiworker/crt-devnet-e2e` from the current `main` (if it exists already, continue on it).
3. Run the acceptance command once before writing any code, to see what is expected:

```sh
node --test acceptance/aiworker-crt-devnet-e2e/
```

## Do

Work through the phases of `aiworker/05-crt-devnet-e2e.md` in order:

1. Phase 1 — `scripts/devnet-e2e.sh`: devnet + CSR contracts + CRT contracts + three registered runners with CRT enabled; `deployments/devnet.json`; `--down`.
2. Phase 2 — `scripts/devnet-scenario.mjs`: create 2-of-3, commits, hard-fail check, arm, kit, renew, release, recover K, cancel + deletions.log, rewrap/dropped; measured cycles table; paste into `DECISIONS.md`.
3. Phase 3 — `scripts/deploy-testnet.sh --dry-run`, `deployments/testnet-runners.json`, `deployments/README.md`, `docs/testing.md`, cycle defaults updated, `docs/manual-steps.md` with the single real deployment command.

After each phase: quality gates of `AIWORKER.md` §3.4, the acceptance command above, a commit
(`type(scope): summary`), and a bullet per decision in `DECISIONS.md` under a `## crt-devnet-e2e` section (newest spec
first in the file).

## Rules that override everything else

- Protected paths (`AIWORKER.md` §3.2) are never edited: `acceptance/**`, `SPEC.md`, `AIWORKER.md`, `aiworker/**`
  and the others listed there. A test you disagree with is implemented as written and the disagreement is noted.
- No manual steps. Anything only a human can do goes into `docs/manual-steps.md` as exact commands, and you continue.
- No secrets, no funded keys, no tokens in the repository.
- Never fake a passing test. A blocked phase stays red and is explained in `DECISIONS.md`.
- You have no testnet CKB and must not look for any; the testnet deployment is the one manual step.
- Advance devnet time the way CSR's own tests do; document the method.

## Finish

Push the branch and open one pull request against `main` using `.github/pull_request_template.md`: phases done,
the acceptance output (last 30 lines), the `DECISIONS.md` section, and any `SPEC.md` change you propose as a
diff in the body. Then stop.
