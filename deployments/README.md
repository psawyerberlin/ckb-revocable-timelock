# Deployments

One JSON file per network, written by `scripts/deploy-testnet.sh` / `scripts/devnet-e2e.sh` and read by
`client/src/chain/deployment.ts` (schema there). Fields: `network_id`, `enabled`, `node_lock {code_hash,
out_point}`, `crt_code_hash`, `crt_data_hash`, `crt_data_cell`, `csr {job_type, job_lock, registry_type_hash,
registry_type_script}`, `type_id_code_hash`, `rpc_urls[]`, `monitor_url`.

`<network>-runners.json`: the public list of CSR runners that announced the CRT service (`SPEC.md` §9), maintained
by pull request: `[{ "runner_lock_hash": "0x…", "peer_id": "Qm…", "label": "…", "since": "2026-11-14" }]`.
