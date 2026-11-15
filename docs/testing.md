# Testing on a devnet

```sh
bash scripts/build-contracts.sh && bash scripts/build-service.sh
bash scripts/devnet-e2e.sh                 # node, CSR contracts, crt-node-lock, 3 runners; idempotent
(cd client && npm ci) && client/node_modules/.bin/tsx scripts/devnet-scenario.mjs
bash scripts/devnet-e2e.sh --down
```

State lives in `.devnet/e2e/` (gitignored). The scenario creates a 2-of-3 switch, waits for commits, exercises the
`VerificationError` rule 1 path, arms, renews, advances node time past `deadline + GRACE` by mining blocks with
future timestamps (`scripts/devnet/crt-smoke.mjs mine-to`) and checks release, cancel (`deletions.log`) and rewrap
(`dropped`). It prints measured cycles per branch and the wall-clock from Create to all commits; the exit code is the
number of failed steps.

## Measured numbers

Devnet run of 2026-11-15 (CSR v0.6.1, 4 runners, `bash scripts/devnet-e2e.sh --runners 4`): ALL PASS, 8/8 steps.

| branch  | cycles |
|---------|--------|
| hold    | 444915 (max of 6, median 444915) |
| keygen  | 4985680 (max of 3, median 4985192) |
| release | 2728057 (max of 5, median 2727813) |

Wall-clock Create -> all commits: 7.7 s. All branches are far below `limits.max_cycles_per_job` (70,000,000).
