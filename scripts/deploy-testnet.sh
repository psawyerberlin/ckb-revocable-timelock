#!/usr/bin/env bash
# Deploys crt-node-lock and the CRT deployment data cell to CKB testnet and writes deployments/testnet.json.
#
# Usage: deploy-testnet.sh --key-file FILE [--node-lock PATH] [--csr DIR] [--rpc URL] [--dry-run] [--help]
#   --key-file FILE  file with the deployer private key (hex), never printed, never stored
#   --node-lock PATH crt-node-lock binary (default contracts/build/release/crt-node-lock)
#   --csr DIR        CSR checkout with a built csr-dev (default .refs/csr)
#   --rpc URL        testnet RPC (default https://testnet.ckb.dev/)
#   --dry-run        print what would be deployed, send nothing, write nothing
# Refuses to overwrite an existing deployments/testnet.json.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
KEY=""; NODE_LOCK="$ROOT/contracts/build/release/crt-node-lock"; CSR_DIR="$ROOT/.refs/csr"; RPC=https://testnet.ckb.dev/; DRY=0
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
ELF="$ROOT/service/build/crt-service.elf"
[ -f "$ELF" ] || { echo "missing $ELF (scripts/build-service.sh)" >&2; exit 1; }
CSR_DEPLOYMENT="$CSR_DIR/deployments/testnet.json"
[ -f "$CSR_DEPLOYMENT" ] || { echo "missing $CSR_DEPLOYMENT (CSR's testnet deployment)" >&2; exit 1; }
TYPE_ID_CODE_HASH=0x00000000000000000000000000000000000000000000000000545950455f4944
WORK="$ROOT/.devnet/testnet-deploy"; mkdir -p "$WORK"
DEPLOY_PY="python3 -I $ROOT/scripts/deployment.py"
export CSR_DEV_TESTNET_KEY="$(tr -d '[:space:]' < "$KEY")"   # csr-dev reads the testnet key from this variable; never printed
if [ "$DRY" = 1 ]; then   # csr-dev has no dry-run: print the plan and stop before anything is sent
  SIZE=$(wc -c < "$NODE_LOCK")
  echo "dry run: would deploy crt-node-lock ($SIZE bytes, about $((SIZE + 100)) CKB locked) and the 102-byte deployment data cell to $RPC"
  echo "         with the key in $KEY; would write $OUT. Nothing sent."
  exit 0
fi
echo "deploying crt-node-lock ($(wc -c < "$NODE_LOCK") bytes) to $RPC"
"$CSR_DEV" --rpc "$RPC" --json deploy-service --elf "$NODE_LOCK" > "$WORK/node-lock.json"
cat "$WORK/node-lock.json"
$DEPLOY_PY data-bin --network-id 1 --node-lock-json "$WORK/node-lock.json" --type-id-hash "$TYPE_ID_CODE_HASH" --out "$WORK/deployment-testnet.bin"
echo "deploying the CRT deployment data cell (102 bytes)"
"$CSR_DEV" --rpc "$RPC" --json deploy-service --elf "$WORK/deployment-testnet.bin" > "$WORK/data.json"
cat "$WORK/data.json"
$DEPLOY_PY write --network testnet --network-id 1 --rpc "$RPC" --monitor-url https://csr-monitor.chainsolution.net/testnet \
  --node-lock-json "$WORK/node-lock.json" --data-json "$WORK/data.json" --data-bin "$WORK/deployment-testnet.bin" \
  --service-elf "$ELF" --csr-deployment "$CSR_DEPLOYMENT" --type-id-hash "$TYPE_ID_CODE_HASH" --out "$OUT"
cp "$WORK/deployment-testnet.bin" "$ROOT/deployments/testnet-data-cell.bin"
echo "wrote $OUT and deployments/testnet-data-cell.bin"
