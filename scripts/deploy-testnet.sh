#!/usr/bin/env bash
# Deploys crt-node-lock and the CRT deployment data cell to CKB testnet and writes deployments/testnet.json.
#
# Usage: deploy-testnet.sh --key-file FILE [--node-lock PATH] [--csr DIR] [--rpc URL] [--dry-run] [--help]
#   --key-file FILE  file with the deployer private key (hex), never printed, never stored
#   --node-lock PATH crt-node-lock binary (default build/crt-node-lock)
#   --csr DIR        CSR checkout with a built csr-dev (default .refs/csr)
#   --rpc URL        testnet RPC (default https://testnet.ckb.dev/)
#   --dry-run        build and print the transactions, send nothing, write nothing
# Refuses to overwrite an existing deployments/testnet.json.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
KEY=""; NODE_LOCK="$ROOT/build/crt-node-lock"; CSR_DIR="$ROOT/.refs/csr"; RPC=https://testnet.ckb.dev/; DRY=0
usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --key-file) KEY="$2"; shift ;;
    --node-lock) NODE_LOCK="$2"; shift ;;
    --csr) CSR_DIR="$2"; shift ;;
    --rpc) RPC="$2"; shift ;;
    --dry-run) DRY=1 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$KEY" ] && [ -f "$KEY" ] || { echo "--key-file FILE is required" >&2; exit 2; }
[ -f "$NODE_LOCK" ] || { echo "missing $NODE_LOCK (scripts/build-contracts.sh)" >&2; exit 1; }
CSR_DEV="$CSR_DIR/target/debug/csr-dev"
[ -x "$CSR_DEV" ] || { echo "missing $CSR_DEV (cargo build -p csr-dev in $CSR_DIR)" >&2; exit 1; }
OUT="$ROOT/deployments/testnet.json"
[ "$DRY" = 1 ] || [ ! -e "$OUT" ] || { echo "$OUT exists; refusing to deploy twice" >&2; exit 1; }
EXTRA=(); [ "$DRY" = 1 ] && EXTRA=(--dry-run)
echo "deploying crt-node-lock ($(wc -c < "$NODE_LOCK") bytes) to $RPC"
RES=$("$CSR_DEV" --rpc "$RPC" --json deploy-service --elf "$NODE_LOCK" --key-file "$KEY" "${EXTRA[@]}")
echo "$RES"
if [ "$DRY" = 1 ]; then echo "dry run: nothing sent, $OUT not written"; exit 0; fi
printf '%s' "$RES" | python3 -I -c '
import json, sys
r = json.load(sys.stdin)
d = {"network": "testnet", "network_id": 1, "enabled": True,
     "node_lock": {"code_hash": r["code_hash"], "hash_type": "data2", "out_point": {"tx_hash": r["tx_hash"], "index": r.get("index", 0)}}}
json.dump(d, open(sys.argv[1], "w"), indent=2); open(sys.argv[1], "a").write("\n")' "$OUT"
echo "wrote $OUT; out point $(python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1]))["node_lock"]["out_point"])' "$OUT")"
