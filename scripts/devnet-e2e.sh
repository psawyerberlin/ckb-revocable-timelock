#!/usr/bin/env bash
# One-command CRT devnet (aiworker/05-crt-devnet-e2e.md, Phase 1).
# Starts a CKB devnet with CSR's scripts/devnet.sh, deploys CSR's contracts, deploys crt-node-lock and the CRT
# deployment data cell, publishes the generic CRT manifest, starts three CSR runners (own data root, service key
# and registration each), enables CRT on each with scripts/crt-enable.sh and writes deployments/devnet.json.
#
# Usage: devnet-e2e.sh [--down] [--csr DIR] [--elf PATH] [--node-lock PATH] [--state DIR] [--runners N] [--help]
#   --down           stop the runners and the devnet node (state under .devnet/ is kept)
#   --csr DIR        CSR checkout, built (csr, csr-dev) with `cargo build` (default .refs/csr, v0.6.1)
#   --elf PATH       crt-service.elf (default service/build/crt-service.elf)
#   --node-lock PATH crt-node-lock binary (default build/crt-node-lock)
#   --state DIR      state directory (default .devnet/e2e)
#   --runners N      number of CSR runners (default 3)
#   --help           this text
# Idempotent: every step is guarded by a marker in the state directory; a second run only restarts what is not
# running. State lives under .devnet/ (gitignored). Needs a devnet-capable machine (CKB binary is downloaded by
# CSR's devnet.sh); it was only statically checked where it was written.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
CSR_DIR="$ROOT/.refs/csr"; ELF="$ROOT/service/build/crt-service.elf"; NODE_LOCK="$ROOT/build/crt-node-lock"
STATE="$ROOT/.devnet/e2e"; N=3; DOWN=0
RPC=http://127.0.0.1:18114

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --down) DOWN=1 ;;
    --csr) CSR_DIR="$2"; shift ;;
    --elf) ELF="$2"; shift ;;
    --node-lock) NODE_LOCK="$2"; shift ;;
    --state) STATE="$2"; shift ;;
    --runners) N="$2"; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
case "$N" in ''|*[!0-9]*) echo "--runners must be a number" >&2; exit 2 ;; esac

DEVNET="bash $CSR_DIR/scripts/devnet.sh"
CSR="$CSR_DIR/target/debug/csr"; CSR_DEV="$CSR_DIR/target/debug/csr-dev"
log() { echo "devnet-e2e: $*"; }
json() { python3 -I -c 'import json,sys; d=json.load(sys.stdin)
for k in sys.argv[1].split("."): d=d[k]
print(d)' "$1"; }

stop_runner() { # dir
  local pf="$1/csr.pid"
  if [ -f "$pf" ] && kill -0 "$(cat "$pf")" 2>/dev/null; then kill "$(cat "$pf")" 2>/dev/null || true; fi
  rm -f "$pf"
}

if [ "$DOWN" = 1 ]; then
  for i in $(seq 1 "$N"); do stop_runner "$STATE/runner$i"; done
  [ -f "$CSR_DIR/scripts/devnet.sh" ] && $DEVNET stop || true
  log "stopped"; exit 0
fi

[ -f "$CSR_DIR/scripts/devnet.sh" ] || { echo "missing $CSR_DIR: git clone --depth 1 --branch v0.6.1 https://github.com/ckb-service-runner/ckb-service-runner .refs/csr" >&2; exit 1; }
for f in "$CSR" "$CSR_DEV" "$ELF" "$NODE_LOCK"; do
  [ -e "$f" ] || { echo "missing $f (build it: cargo build / cargo build -p csr-dev in the CSR checkout, scripts/build-service.sh, scripts/build-contracts.sh)" >&2; exit 1; }
done
mkdir -p "$STATE"

# 1. devnet node (no-op when running) and CSR contracts
$DEVNET start
if [ ! -f "$STATE/csr-contracts.done" ] || [ ! -f "$CSR_DIR/deployments/devnet.json" ]; then
  (cd "$CSR_DIR" && "$CSR_DEV" deploy-contracts >/dev/null)
  touch "$STATE/csr-contracts.done"
fi
log "CSR contracts deployed"

# 2. crt-node-lock and the deployment data cell
if [ ! -f "$STATE/node-lock-deploy.json" ]; then
  "$CSR_DEV" --rpc "$RPC" --json deploy-service --elf "$NODE_LOCK" > "$STATE/node-lock-deploy.json.tmp"
  mv "$STATE/node-lock-deploy.json.tmp" "$STATE/node-lock-deploy.json"
fi
NODE_LOCK_HASH=$(json code_hash < "$STATE/node-lock-deploy.json")
NODE_LOCK_TX=$(json tx_hash < "$STATE/node-lock-deploy.json")
$DEVNET mine 3 >/dev/null
log "crt-node-lock deployed ($NODE_LOCK_HASH)"

# 3. publish the generic CRT manifest (deployment data cell + service ELF code cell)
if [ ! -f "$STATE/service-deploy.json" ]; then
  "$CSR_DEV" --rpc "$RPC" --json deploy-service --elf "$ELF" --manifest "$ROOT/service/manifests/crt-local.toml.in" \
    > "$STATE/service-deploy.json.tmp"
  mv "$STATE/service-deploy.json.tmp" "$STATE/service-deploy.json"
  $DEVNET mine 3 >/dev/null
fi
log "generic manifest published"

# 4. deployments/devnet.json (read by crt-enable.sh --network and the client); the type-id code hash is the
#    devnet's built-in Type ID script.
TYPE_ID_CODE_HASH=0x00000000000000000000000000000000000000000000000000545950455f4944
python3 -I - "$ROOT/deployments/devnet.json" "$NODE_LOCK_HASH" "$NODE_LOCK_TX" "$TYPE_ID_CODE_HASH" "$STATE/service-deploy.json" <<'PY'
import json, sys
out, code_hash, tx, tid, svc = sys.argv[1:6]
d = {"network": "devnet", "network_id": 2, "enabled": True,
     "node_lock": {"code_hash": code_hash, "hash_type": "data2", "out_point": {"tx_hash": tx, "index": 0}},
     "type_id_code_hash": tid, "service": json.load(open(svc))}
tmp = out + ".tmp"
open(tmp, "w").write(json.dumps(d, indent=2) + "\n")
import os; os.replace(tmp, out)
PY
log "wrote deployments/devnet.json"
python3 -I - "$ROOT/deployments/devnet.json" "$STATE/deployment-devnet.bin" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
h = lambda s: bytes.fromhex(s[2:] if s.startswith("0x") else s)
op = d["node_lock"]["out_point"]
out = bytes([1, d["network_id"]]) + h(d["node_lock"]["code_hash"]) + h(op["tx_hash"]) + op["index"].to_bytes(4, "little") + h(d["type_id_code_hash"])
assert len(out) == 102, len(out)
open(sys.argv[2], "wb").write(out)
PY

# 5. runners: own data root, config, dashboard port and service key; registration with a devnet stake
for i in $(seq 1 "$N"); do
  RD="$STATE/runner$i"; DR="$RD/data"; mkdir -p "$DR"
  BIN="$RD/csr"   # wrapper that pins the data root so crt-enable.sh can call it as `--csr-bin`
  printf '#!/usr/bin/env bash\nexec "%s" --data-root "%s" --config "%s" "$@"\n' "$CSR" "$DR" "$DR/csr.toml" > "$BIN"
  chmod +x "$BIN"
  if [ ! -f "$DR/csr.toml" ]; then
    cat > "$DR/csr.toml" <<TOML
network = "devnet"
[node]
rpc_url = "$RPC"
[devnet]
deployments = "$CSR_DIR/deployments/devnet.json"
[dashboard]
bind = "127.0.0.1:$((8130 + i))"
[ranking]
join = true
ping_bind = "127.0.0.1:$((8140 + i))"
[runtime]
enabled = true
[limits]
max_cycles_per_job = 70000000
TOML
  fi
  if [ ! -f "$RD/registered" ]; then
    IDENT=$("$BIN" identity --json)
    LOCK_ARGS=$(printf '%s' "$IDENT" | json runner_lock_args)
    PUBKEY=$(printf '%s' "$IDENT" | json service_pubkey)
    PEER=$(printf '%s' "$IDENT" | json peer_id)
    "$CSR_DEV" --rpc "$RPC" --json fund --lock-args "$LOCK_ARGS" --ckb 1200 >/dev/null
    STAKE=$("$CSR_DEV" --rpc "$RPC" --json dao-deposit --ckb 10000)
    STAKE_OP="$(printf '%s' "$STAKE" | json tx_hash):$(printf '%s' "$STAKE" | json index)"
    $DEVNET mine 5 >/dev/null
    MSG=$("$BIN" register consent-message --stake "$STAKE_OP" --json | json message)
    SIG=$("$CSR_DEV" --json sign-message --text "$MSG" --key genesis | json signature)
    "$CSR_DEV" --rpc "$RPC" --json attest --peer-id "$PEER" --service-pubkey "$PUBKEY" --stake "$STAKE_OP" \
      --network devnet --out "$RD/att.json" --deployments "$CSR_DIR/deployments/devnet.json" >/dev/null
    "$BIN" register create --stake "$STAKE_OP" --consent "$SIG" --attestation "$RD/att.json" --json >/dev/null
    $DEVNET mine 3 >/dev/null
    touch "$RD/registered"
  fi
  # CRT on this runner (idempotent). crt-enable.sh only knows testnet|mainnet as --network; the devnet data cell
  # (SPEC.md 5.5, 102 bytes) is built here and passed with --data-cell, so the network name only picks defaults.
  bash "$ROOT/scripts/crt-enable.sh" --network testnet --csr "$BIN" --workdir "$RD/crt" --elf "$ELF" \
    --data-cell "$STATE/deployment-devnet.bin" >/dev/null
  # start the runner unless it runs
  if ! { [ -f "$RD/csr.pid" ] && kill -0 "$(cat "$RD/csr.pid")" 2>/dev/null; }; then
    nohup "$BIN" run >"$RD/csr.log" 2>&1 &
    echo $! > "$RD/csr.pid"
  fi
  log "runner $i up (dashboard http://127.0.0.1:$((8130 + i)))"
done
log "ready: run node scripts/devnet-scenario.mjs; stop with: bash scripts/devnet-e2e.sh --down"
