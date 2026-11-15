#!/usr/bin/env bash
# Devnet smoke test of the CRT service (aiworker/02-crt-service.md, Phase 4).
# Needs a local CSR checkout (scripts/devnet.sh, csr-dev, csr), a built service ELF and a built crt-node-lock.
# Prints PASS/FAIL per step; exits non-zero on the first FAIL.
#
# Usage: devnet-service-smoke.sh [--csr DIR] [--elf PATH] [--node-lock PATH] [--workdir DIR]
#                                [--create-switch CMD] [--help]
#   --csr DIR            CSR checkout (default .refs/csr)
#   --elf PATH           crt-service.elf (default service/build/crt-service.elf)
#   --node-lock PATH     crt-node-lock binary (default build/crt-node-lock)
#   --workdir DIR        service state dir (default .devnet/crt-service-smoke)
#   --create-switch CMD  command that creates ONE switch on the devnet for runner lock hash $CRT_R and prints
#                        "<T hex> <deadline unix seconds>" (default: client/scripts/devnet-create-switch.mjs if present).
#                        Run it twice per smoke run (switch A: heartbeat/release, switch B: consume).
# Environment: CRT_DEADLINE_OFFSET (seconds from tip, default 600).
# This script was only statically checked (bash -n); it needs a devnet and is run in project crt-devnet-e2e.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
CSR_DIR="$ROOT/.refs/csr"; ELF="$ROOT/service/build/crt-service.elf"; NODE_LOCK="$ROOT/build/crt-node-lock"
WORK="$ROOT/.devnet/crt-service-smoke"; CREATE=""
GRACE=86400

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --csr) CSR_DIR="$2"; shift ;;
    --elf) ELF="$2"; shift ;;
    --node-lock) NODE_LOCK="$2"; shift ;;
    --workdir) WORK="$2"; shift ;;
    --create-switch) CREATE="$2"; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$CREATE" ] || { [ -f "$ROOT/client/scripts/devnet-create-switch.mjs" ] && CREATE="node $ROOT/client/scripts/devnet-create-switch.mjs"; }

HELPER="node $ROOT/scripts/devnet/crt-smoke.mjs"
DEVNET="bash $CSR_DIR/scripts/devnet.sh"
CSR_DEV="$CSR_DIR/target/debug/csr-dev"
CSR="$CSR_DIR/target/debug/csr"
STEP=0
pass() { STEP=$((STEP+1)); echo "PASS [$STEP] $*"; }
fail() { STEP=$((STEP+1)); echo "FAIL [$STEP] $*" >&2; exit 1; }
need() { [ -e "$1" ] || fail "missing $1 ($2)"; }

need "$CSR_DIR/scripts/devnet.sh" "clone CSR into .refs/csr"
need "$CSR_DEV" "cargo build -p csr-dev in the CSR checkout"
need "$CSR" "cargo build in the CSR checkout"
need "$ELF" "scripts/build-service.sh"
need "$NODE_LOCK" "scripts/build-contracts.sh"
[ -n "$CREATE" ] || fail "no switch creator: pass --create-switch CMD or add client/scripts/devnet-create-switch.mjs"
mkdir -p "$WORK"

# 1. devnet + CSR contracts
$DEVNET start >/dev/null && pass "devnet started" || fail "devnet start"
"$CSR_DEV" deploy-contracts >/dev/null && pass "CSR contracts deployed" || fail "csr-dev deploy-contracts"

# 2. deploy crt-node-lock and the deployment data cell
DEPLOY_JSON=$("$CSR_DEV" --json deploy-service --elf "$NODE_LOCK") || fail "deploy crt-node-lock"
echo "$DEPLOY_JSON" > "$WORK/node-lock-deploy.json"
NODE_LOCK_HASH=$(python3 -I -c 'import json,sys; print(json.load(sys.stdin)["code_hash"])' < "$WORK/node-lock-deploy.json")
[ -n "$NODE_LOCK_HASH" ] && pass "crt-node-lock deployed ($NODE_LOCK_HASH)" || fail "no code hash"

# 3. publish the generic manifest and register a devnet runner (service = the ELF as a local service)
"$CSR_DEV" deploy-service --elf "$ELF" --manifest "$ROOT/service/manifests/crt-local.toml.in" >"$WORK/service-deploy.json" \
  && pass "generic manifest published" || fail "manifest publish"
CRT_R=$("$CSR" identity --json | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["runner_lock_hash"])')
export CRT_R
"$CSR" service add-local --elf "$ELF" >/dev/null && "$CSR" service enable >/dev/null \
  && pass "runner registered, service enabled (R=$CRT_R)" || fail "runner registration"

# 4. switch A: create, the service arms it (state 1)
read -r T_A DEADLINE_A <<<"$($CREATE)"
[ -n "${T_A:-}" ] && pass "switch A created (T=$T_A, deadline=$DEADLINE_A)" || fail "create switch A"
wait_state() { # T want timeout-iterations
  local i s
  for i in $(seq 1 "$3"); do
    s=$($HELPER node-state "$1" "$CRT_R" "$NODE_LOCK_HASH" || true)
    [ "$s" = "$2" ] && return 0
    $DEVNET mine 2 >/dev/null; sleep 3
  done
  return 1
}
wait_state "$T_A" 1 60 && pass "Node Cell reached state 1 (key generated)" || fail "Node Cell did not reach state 1"

# 5. advance the devnet clock past deadline + GRACE and watch state 2
$HELPER mine-to $((DEADLINE_A + GRACE + 60)) >/dev/null && pass "devnet median time past deadline + GRACE" || fail "advance clock"
wait_state "$T_A" 2 60 && pass "Node Cell reached state 2 (released)" || fail "Node Cell did not reach state 2"

# 6. switch B: consume the Alive Cell, expect the key deletion in the service's log
read -r T_B DEADLINE_B <<<"$($CREATE)"
[ -n "${T_B:-}" ] && pass "switch B created (T=$T_B)" || fail "create switch B"
wait_state "$T_B" 1 60 && pass "switch B armed" || fail "switch B did not reach state 1"
CSR_DEV_CONSUME=1 $CREATE --consume-alive "$T_B" >/dev/null && pass "Alive Cell of B consumed" || fail "consume Alive Cell"
LOG=""
for d in "$HOME/.csr/service_data" "$WORK/service_data" "${CSR_DATA_DIR:-/nonexistent}/service_data"; do
  [ -f "$d/deletions.log" ] && LOG="$d/deletions.log" && break
done
for _ in $(seq 1 40); do
  [ -n "$LOG" ] && grep -qi "${T_B#0x}" "$LOG" && break
  $DEVNET mine 2 >/dev/null; sleep 3
done
if [ -n "$LOG" ] && grep -qi "${T_B#0x}" "$LOG"; then pass "service_data/deletions.log records the deletion of B"
else fail "no deletion of B in service_data/deletions.log"; fi

$DEVNET stop >/dev/null || true
echo "PASS all $STEP steps"
