# Spec 05 — devnet end-to-end, cycle budgets, testnet deployment (`crt-devnet-e2e`)

**Branch:** `aiworker/crt-devnet-e2e`. **Acceptance:** `acceptance/aiworker-crt-devnet-e2e/`.
**Depends on:** specs 01–04; CSR ≥ 0.6.1.

## Phase 1 — one-command devnet

`scripts/devnet-e2e.sh`: starts a devnet with CSR's `scripts/devnet.sh` (ckb 0.2xx as CSR pins), deploys CSR's
contracts with `csr-dev deploy-contracts`, deploys `crt-node-lock` and the CRT deployment data cell, publishes
the generic CRT manifest, starts **three** CSR runner instances (three data roots, three service keys, three
registrations with devnet stakes — reuse what CSR's devnet scripts already do for one and loop), enables CRT on
each with `scripts/crt-enable.sh --csr-bin … --data-root …`, and writes `deployments/devnet.json`. Idempotent;
`--down` stops everything; state under `.devnet/`.

## Phase 2 — the scenario

`scripts/devnet-scenario.mjs` (Node, uses `client/`):

1. create a 2-of-3 switch with deadline = now + 10 minutes of devnet median time (the devnet mines fast; the
   script reads `get_tip_header` for the real median time);
2. wait for 3 commits (poll Node Cells); verify (hard-fail path exercised: temporarily point the deployment at a
   wrong `node_lock_code_hash` and assert `VerificationError` rule 1, then restore);
3. arm; generate the kit; wrap a random `K`;
4. renew once (+10 minutes) and assert new heartbeat jobs and unchanged `I`;
5. advance devnet time past `deadline + GRACE` (CSR's devnet exposes a clock: use `csr-dev` as CSR's own tests do,
   or mine with future timestamps; document the way) and wait for 3 releases; `collectReleases` → `K` equal;
6. a second switch: cancel before deadline; assert that `service_data/deletions.log` of each runner gained one
   line and that no release ever appears after advancing time;
7. rewrap on a third switch: drop runner 3, add none, assert runner 3 reports `dropped` on its next heartbeat
   (read the run result from its dashboard `GET /api/jobs/{id}`).

Prints a table of **measured cycles** per branch (hold, keygen, release) from the runners' job runs and
**wall-clock from Create to all commits**. Exit code = number of failed steps.

## Phase 3 — testnet deployment files (no funds required from the worker)

* `scripts/deploy-testnet.sh`: deploys `crt-node-lock` and the data cell and publishes the manifest **from a key
  file given on the command line**; prints the out points; writes `deployments/testnet.json`. The worker runs it
  only with `--dry-run` (builds and prints the transactions) and writes the one real invocation, with the
  expected cost, into `docs/manual-steps.md` — the only manual step of the project.
* `deployments/testnet-runners.json`: empty list with the schema; `deployments/README.md`.
* `docs/testing.md`: how to run the devnet, the scenario, and what the numbers were on the worker's machine.
* Update the cycle defaults in `client/src/tx/defaults.ts` and `SPEC.md` §5.4 **proposal** (in the PR body) from
  the measurements.

## Acceptance

```sh
node --test acceptance/aiworker-crt-devnet-e2e/
```

The judge has no devnet: the acceptance tests check the scripts' presence, flags, idempotency guards and the
`docs/manual-steps.md` content; the scenario's PASS output is pasted into `DECISIONS.md`.
