# Manual steps

Everything else is automated; these are the only things a human runs. Run from the repository root on a machine
with a CKB node binary, Docker-free, with Rust, Node 22 and Python 3.

## A. Devnet run (no funds needed)

```sh
. "$HOME/.cargo/env"
[ -d .refs/csr ] || git clone --depth 1 --branch v0.6.1 https://github.com/ckb-service-runner/ckb-service-runner .refs/csr
(cd .refs/csr && cargo build -p csr -p csr-dev)
bash scripts/build-contracts.sh
bash scripts/build-service.sh
bash scripts/devnet-e2e.sh --runners 3
node --experimental-strip-types scripts/devnet-scenario.mjs      # prints PASS lines and measured cycles
bash scripts/devnet-e2e.sh --down
```

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

Expected cost: about 20,000 CKB locked as capacity of the code cell (roughly the binary size in bytes plus
overhead, in CKB) plus fees below 0.01 CKB. The locked CKB is recovered by consuming the cell. The script refuses
to run twice while `deployments/testnet.json` exists.
