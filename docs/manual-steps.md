# Manual steps

The only step that needs funds is the testnet deployment.

1. Build the contract: `bash scripts/build-contracts.sh`, and CSR's `csr-dev` in `.refs/csr`.
2. Put a funded testnet key in a file outside the repository (`chmod 600`).
3. Check with `bash scripts/deploy-testnet.sh --key-file KEY --dry-run`.
4. Deploy once: `bash scripts/deploy-testnet.sh --key-file KEY`.
5. Commit the written `deployments/testnet.json`.

Expected cost: about 20,000 CKB, locked as capacity of the code cell (one cell holding the `crt-node-lock` binary,
roughly its size in bytes plus overhead in CKB) plus fees below 0.01 CKB. Locked CKB can be recovered by consuming the cell.
