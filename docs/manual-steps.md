# Manual steps

Everything else is automated; these are the only things a human runs. Run from the repository root on a machine
with a CKB node binary, Docker-free, with Rust, Node 22 and Python 3.

## A. Devnet run (no funds needed)

```sh
. "$HOME/.cargo/env"
[ -d .refs/csr ] || git clone --depth 1 --branch v0.6.1 https://github.com/ckb-service-runner/ckb-service-runner .refs/csr
(cd .refs/csr && cargo build -p csr -p csr-dev && bash scripts/build-contracts.sh)
bash scripts/build-contracts.sh
bash scripts/build-service.sh
bash scripts/devnet-e2e.sh --runners 3
(cd client && npm ci) && client/node_modules/.bin/tsx scripts/devnet-scenario.mjs      # prints PASS lines and measured cycles
bash scripts/devnet-e2e.sh --down
```

The scenario moves the chain clock forward (blocks with future timestamps) and refuses to start when the chain clock
is not within 10 minutes of the wall clock, because the runners idle on a skewed chain. Before every rerun use a fresh
devnet: `bash scripts/devnet-e2e.sh --reset && bash scripts/devnet-e2e.sh --runners 3`.

Paste the PASS output into `DECISIONS.md` and the measured cycles into `docs/testing.md` and
`client/src/tx/defaults.ts`.

## B. Testnet deployment (needs funds)

```sh
bash scripts/build-contracts.sh
chmod 600 /path/to/testnet.key          # funded testnet key, outside the repository
bash scripts/deploy-testnet.sh --key-file /path/to/testnet.key --dry-run
bash scripts/deploy-testnet.sh --key-file /path/to/testnet.key
git add deployments/testnet.json && git commit -m "Testnet deployment"
```

Expected cost: about 52,700 CKB locked as capacity of the code cell (the binary is 52,584 bytes and a cell needs
1 CKB per byte plus about 100 CKB of overhead) plus the small deployment data cell and fees below 0.01 CKB. Fund the
deployer with at least 53,000 CKB (testnet CKB comes from the faucet). The locked CKB is recovered by consuming the cell. The script refuses
to run twice while `deployments/testnet.json` exists.
