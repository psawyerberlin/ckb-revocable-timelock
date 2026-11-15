#!/usr/bin/env bash
# Operator script: publishes the CRT service on a network and one on-chain manifest per runner.
# CSR keys a service by (code hash, args, data cells) only when it comes from an on-chain manifest, and a manifest can
# only be published by the owner of the code cell (publisher binding). So the owner of the deployer key publishes one
# manifest per runner (args = that runner's lock hash R); each runner admin then runs scripts/crt-enable.sh.
#
# Usage: crt-publish.sh --key-file FILE --csr PATH [--network testnet] [--runner-lock-hash 0x..]... [--elf PATH]
#                       [--csr-dev PATH] [--dry-run]
#   --key-file FILE   the deployer key (the one that deployed crt-node-lock); never printed
#   --csr PATH        a csr binary configured for the network (its csr.toml and RPC are used; runner state is not changed)
#   --runner-lock-hash R   publish the manifest for this runner (repeat for several; without it, only the code cell)
#   --elf PATH        crt-service.elf (default service/build/crt-service.elf)
#   --csr-dev PATH    csr-dev (default .refs/csr/target/debug/csr-dev)
#   --dry-run         build and check, send nothing
# Writes deployments/<network>-service.json (the code cell) and deployments/<network>-manifests/<R>.json; commit them.
# Idempotent: an existing code cell file or manifest file is reused.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
NETWORK=testnet; KEY=""; CSR=""; ELF="$ROOT/service/build/crt-service.elf"; CSR_DEV="$ROOT/.refs/csr/target/debug/csr-dev"; DRY=0; RS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --network) NETWORK="$2"; shift ;;
    --key-file) KEY="$2"; shift ;;
    --csr) CSR="$2"; shift ;;
    --runner-lock-hash) RS+=("$2"); shift ;;
    --elf) ELF="$2"; shift ;;
    --csr-dev) CSR_DEV="$2"; shift ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
case "$NETWORK" in testnet|mainnet) ;; *) echo "--network must be testnet or mainnet" >&2; exit 2 ;; esac
[ -n "$KEY" ] && [ -f "$KEY" ] || { echo "--key-file FILE is required" >&2; exit 2; }
[ -n "$CSR" ] && [ -x "$CSR" ] || { echo "--csr PATH (an executable csr) is required" >&2; exit 2; }
[ -f "$ELF" ] || { echo "missing $ELF (scripts/build-service.sh)" >&2; exit 1; }
[ -x "$CSR_DEV" ] || { echo "missing $CSR_DEV (cargo build -p csr-dev in .refs/csr)" >&2; exit 1; }
DEP="$ROOT/deployments/$NETWORK.json"
[ -f "$DEP" ] || { echo "missing $DEP (deploy crt-node-lock first: scripts/deploy-testnet.sh)" >&2; exit 1; }
json() { python3 -I -c 'import json,sys; print(json.load(sys.stdin)[sys.argv[1]])' "$1"; }
RPC=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["rpc_urls"][0])' "$DEP")
DATA_TX=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["crt_data_cell"]["tx_hash"])' "$DEP")
CRT_CODE_HASH=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["crt_code_hash"])' "$DEP")
SVC="$ROOT/deployments/$NETWORK-service.json"
MAN="$ROOT/deployments/$NETWORK-manifests"; mkdir -p "$MAN"
export CSR_DEV_TESTNET_KEY="$(tr -d '[:space:]' < "$KEY")"
live() {   # wait (up to 5 minutes) until an out point is live: 0x<tx>:<index>
  python3 -I - "$RPC" "$1" <<'PY'
import json, sys, time, urllib.request
rpc, op = sys.argv[1], sys.argv[2]
tx, idx = op.split(":")
body = json.dumps({"id": 1, "jsonrpc": "2.0", "method": "get_live_cell", "params": [{"tx_hash": tx, "index": hex(int(idx))}, False]}).encode()
for _ in range(60):
    try:
        r = json.load(urllib.request.urlopen(urllib.request.Request(rpc, body, {"Content-Type": "application/json", "User-Agent": "Mozilla/5.0 crt-tools"}), timeout=30))
        if (r.get("result") or {}).get("status") == "live":
            sys.exit(0)
    except Exception:
        pass
    time.sleep(5)
sys.exit("timeout: " + op + " is not live yet")
PY
}

# 1. the service ELF as a code cell (its data hash must equal crt_code_hash of the deployment file)
GOT=$(python3 -I -c 'import hashlib,sys; print("0x"+hashlib.blake2b(open(sys.argv[1],"rb").read(),digest_size=32,person=b"ckb-default-hash").hexdigest())' "$ELF")
[ "$GOT" = "$CRT_CODE_HASH" ] || { echo "the ELF's data hash $GOT is not crt_code_hash $CRT_CODE_HASH of $DEP: wrong binary" >&2; exit 1; }
if [ ! -f "$SVC" ]; then
  SIZE=$(wc -c < "$ELF")
  if [ "$DRY" = 1 ]; then echo "[dry-run] would deploy $ELF ($SIZE bytes, about $((SIZE + 100)) CKB locked) as a code cell to $RPC"
  else
    echo "deploying the CRT service code cell ($SIZE bytes) to $RPC"
    "$CSR_DEV" --rpc "$RPC" --json deploy-service --elf "$ELF" > "$SVC.tmp"
    mv "$SVC.tmp" "$SVC"
  fi
fi
if [ -f "$SVC" ]; then
  CODE_OP="$(json tx_hash < "$SVC"):0"
  [ "$DRY" = 1 ] || live "$CODE_OP"
  echo "code cell: $CODE_OP"
else
  CODE_OP="0x<code cell tx>:0"
fi

# 2. one manifest per runner (args = R)
for R in "${RS[@]:-}"; do
  [ -n "$R" ] || continue
  case "$R" in 0x[0-9a-fA-F]*) [ ${#R} -eq 66 ] || { echo "bad runner lock hash $R" >&2; exit 1; } ;; *) echo "bad runner lock hash $R" >&2; exit 1 ;; esac
  OUT="$MAN/$R.json"
  if [ -f "$OUT" ]; then echo "manifest for $R exists: $OUT"; continue; fi
  ARGS=(service publish --code-outpoint "$CODE_OP" --data-outpoint "$DATA_TX:0" --args "$R" --name crt --version 0.2.0
        --language rust --min-csr 0.6.1 --description "CRT (CKB Revocable Timelock) service of the runner with lock hash $R" --key "$KEY")
  if [ "$DRY" = 1 ]; then
    echo "[dry-run] $CSR ${ARGS[*]} --dry-run"
    [ -f "$SVC" ] && "$CSR" "${ARGS[@]}" --dry-run || true
    continue
  fi
  "$CSR" "${ARGS[@]}" > "$OUT.tmp"
  live "$(json manifest_outpoint < "$OUT.tmp")"
  mv "$OUT.tmp" "$OUT"
  echo "manifest for $R: $(json manifest_outpoint < "$OUT") (service ID $(json service_id < "$OUT"))"
done
[ "$DRY" = 1 ] || echo "now: git add deployments/$NETWORK-service.json deployments/$NETWORK-manifests && git commit && git push"
