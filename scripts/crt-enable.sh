#!/usr/bin/env bash
# Enables the CRT service on this CSR runner (docs/operators.md).
# Usage: crt-enable.sh [--network testnet|mainnet] [--dry-run] [--csr PATH] [--manifest FILE] [--runner-lock-hash 0x..]
# The CRT operator publishes one on-chain manifest per runner (scripts/crt-publish.sh, args = the runner's lock hash R)
# and lists it in deployments/<network>-manifests/<R>.json of the repository. This script finds the file for your R
# (a local checkout, or raw.githubusercontent.com), then runs `csr service add-onchain --manifest <out point> --approve`
# and `csr service enable <service id>`. The service code runs from the code cell on chain; no binary is downloaded.
# Idempotent: a second run changes nothing.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." 2>/dev/null && pwd || pwd)
NETWORK=testnet; DRY=0; CSR=""; R=""; FILE=""
WORK="${CRT_STATE_DIR:-$HOME/.crt-service}"
REPO=psawyerberlin/ckb-revocable-timelock
while [ $# -gt 0 ]; do
  case "$1" in
    --network) NETWORK="$2"; shift ;;
    --dry-run) DRY=1 ;;
    --csr) CSR="$2"; shift ;;
    --manifest) FILE="$2"; shift ;;
    --runner-lock-hash) R="$2"; shift ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
case "$NETWORK" in testnet|mainnet) ;; *) echo "--network must be testnet or mainnet" >&2; exit 2 ;; esac
run() { if [ "$DRY" = 1 ]; then echo "[dry-run] $*"; else "$@"; fi; }
json() { python3 -I -c 'import json,sys; print(json.load(sys.stdin)[sys.argv[1]])' "$1"; }

# 1. csr
if [ -z "$CSR" ]; then
  CSR=$(command -v csr || true)
  [ -z "$CSR" ] && [ -x /usr/local/bin/csr ] && CSR=/usr/local/bin/csr
fi
[ -n "$CSR" ] || { echo "csr not found (PATH or /usr/local/bin); use --csr PATH" >&2; exit 1; }

# 2. R = runner lock hash (CSR 0.6.x: `csr identity --json`)
if [ -z "$R" ]; then
  R=$("$CSR" identity --json | json runner_lock_hash)
fi
case "$R" in 0x[0-9a-fA-F]*) [ ${#R} -eq 66 ] || { echo "bad runner lock hash $R" >&2; exit 1; } ;; *) echo "bad runner lock hash $R" >&2; exit 1 ;; esac
echo "Runner lock hash R: $R"

# 3. the manifest the operator published for this runner
if [ -z "$FILE" ]; then
  FILE="$ROOT/deployments/$NETWORK-manifests/$R.json"
  if [ ! -f "$FILE" ]; then
    mkdir -p "$WORK"; FILE="$WORK/$NETWORK-$R.json"
    URL="https://raw.githubusercontent.com/$REPO/main/deployments/$NETWORK-manifests/$R.json"
    if ! curl -fsSL "$URL" -o "$FILE.tmp" 2>/dev/null; then
      rm -f "$FILE.tmp"
      echo "No CRT manifest has been published for your runner yet ($URL)." >&2
      echo "Send your runner lock hash to the CRT operator:  $R" >&2
      echo "The operator runs scripts/crt-publish.sh for it; run this script again afterwards." >&2
      exit 1
    fi
    mv "$FILE.tmp" "$FILE"
  fi
fi
OUTPOINT=$(json manifest_outpoint < "$FILE"); SID=$(json service_id < "$FILE")

# 4. add (approve) and enable; both are no-ops when repeated
run "$CSR" service add-onchain --manifest "$OUTPOINT" --approve
run "$CSR" service enable "$SID"
echo "CRT service ID: $SID"
echo "Check the Jobs page of your dashboard (see csr.toml [dashboard].bind) for CRT jobs."
