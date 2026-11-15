# Testing on a devnet

```sh
bash scripts/build-contracts.sh && bash scripts/build-service.sh
bash scripts/devnet-e2e.sh                 # node, CSR contracts, crt-node-lock, 3 runners; idempotent
node --experimental-strip-types scripts/devnet-scenario.mjs
bash scripts/devnet-e2e.sh --down
```

State lives in `.devnet/e2e/` (gitignored). The scenario creates a 2-of-3 switch, waits for commits, exercises the
`VerificationError` rule 1 path, arms, renews, advances node time past `deadline + GRACE` by mining blocks with
future timestamps (`scripts/devnet/crt-smoke.mjs mine-to`) and checks release, cancel (`deletions.log`) and rewrap
(`dropped`). It prints measured cycles per branch and the wall-clock from Create to all commits; the exit code is the
number of failed steps.

## Measured numbers

Not yet measured: the scripts were written where no devnet is available. Run the scenario and paste the table here.
