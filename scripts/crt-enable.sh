#!/usr/bin/env bash
# Enables the CRT service on this CSR runner (docs/operators.md).
# Usage: crt-enable.sh [--network testnet|mainnet] [--dry-run] [--csr PATH] [--elf PATH] [--version X.Y.Z]
#                      [--data-cell PATH] [--workdir DIR] [--runner-lock-hash 0x..]
# Idempotent: a second run with the same inputs changes nothing.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." 2>/dev/null && pwd || pwd)
NETWORK=testnet; DRY=0; CSR=""; ELF=""; VERSION=""; DATA=""; R=""
WORK="${CRT_STATE_DIR:-$HOME/.crt-service}"
REPO=psawyerberlin/ckb-revocable-timelock
while [ $# -gt 0 ]; do
  case "$1" in
    --network) NETWORK="$2"; shift ;;
    --dry-run) DRY=1 ;;
    --csr) CSR="$2"; shift ;;
    --elf) ELF="$2"; shift ;;
    --version) VERSION="$2"; shift ;;
    --data-cell) DATA="$2"; shift ;;
    --workdir) WORK="$2"; shift ;;
    --runner-lock-hash) R="$2"; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
case "$NETWORK" in testnet|mainnet) ;; *) echo "--network must be testnet or mainnet" >&2; exit 2 ;; esac
run() { if [ "$DRY" = 1 ]; then echo "[dry-run] $*"; else "$@"; fi; }

# 1. csr
if [ -z "$CSR" ]; then
  CSR=$(command -v csr || true)
  [ -z "$CSR" ] && [ -x /usr/local/bin/csr ] && CSR=/usr/local/bin/csr
fi
[ -n "$CSR" ] || { echo "csr not found (PATH or /usr/local/bin)" >&2; exit 1; }

# 2. R = runner lock hash. CSR 0.6.x: `csr identity --json` prints runner_lock_hash (the blake2b256 of the
# secp256k1_blake160 lock of blake160(service_pubkey)).
if [ -z "$R" ]; then
  if [ "$DRY" = 1 ] && ! "$CSR" version >/dev/null 2>&1; then R="0x$(printf '00%.0s' $(seq 32))"
  else
    R=$("$CSR" identity --json | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["runner_lock_hash"])')
  fi
fi
case "$R" in 0x[0-9a-fA-F][0-9a-fA-F]*) [ ${#R} -eq 66 ] || { echo "bad runner lock hash $R" >&2; exit 1; } ;; *) echo "bad runner lock hash $R" >&2; exit 1 ;; esac

# 3. the binary: local path, or the release asset checked against SHA256SUMS
mkdir -p "$WORK"
if [ -z "$ELF" ]; then
  if [ -z "$VERSION" ]; then
    VERSION=$("$CSR" version 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
    VERSION=${VERSION:-latest}
  fi
  BASE="https://github.com/$REPO/releases/download/v$VERSION"
  [ "$VERSION" = latest ] && BASE="https://github.com/$REPO/releases/latest/download"
  ELF="$WORK/crt-service.elf"
  if [ "$DRY" = 1 ]; then
    echo "[dry-run] download $BASE/crt-service.elf and verify against $BASE/SHA256SUMS"
  else
    curl -fsSL "$BASE/crt-service.elf" -o "$ELF.tmp"
    curl -fsSL "$BASE/SHA256SUMS" -o "$WORK/SHA256SUMS"
    WANT=$(grep -E ' \*?crt-service\.elf$' "$WORK/SHA256SUMS" | awk '{print $1}')
    GOT=$(sha256sum "$ELF.tmp" | awk '{print $1}')
    [ -n "$WANT" ] && [ "$WANT" = "$GOT" ] || { rm -f "$ELF.tmp"; echo "SHA256 mismatch for crt-service.elf" >&2; exit 1; }
    mv "$ELF.tmp" "$ELF"
  fi
fi

# 4. deployment data cell (SPEC.md §5.5, 102 bytes), from deployments/<network>.json unless given
if [ -z "$DATA" ]; then
  DATA="$WORK/deployment-$NETWORK.bin"
  DEP="$ROOT/deployments/$NETWORK.json"
  [ -f "$DEP" ] || DEP="$WORK/$NETWORK.json"
  if [ ! -f "$DEP" ] && [ "$DRY" = 0 ]; then
    curl -fsSL "https://raw.githubusercontent.com/$REPO/main/deployments/$NETWORK.json" -o "$WORK/$NETWORK.json"
    DEP="$WORK/$NETWORK.json"
  fi
  if [ "$DRY" = 1 ]; then echo "[dry-run] build $DATA from $DEP"
  else
    python3 -I - "$DEP" "$DATA" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
if not d.get("enabled", True) or "node_lock" not in d:
    sys.exit("CRT is not deployed on this network (deployments file has no node_lock)")
h = lambda s: bytes.fromhex(s[2:] if s.startswith("0x") else s)
op = d["node_lock"]["out_point"]
tx, idx = (op["tx_hash"], op["index"]) if isinstance(op, dict) else op.split(":")
idx = int(idx, 0) if isinstance(idx, str) else idx
out = bytes([1, d["network_id"]]) + h(d["node_lock"]["code_hash"]) + h(tx) + idx.to_bytes(4, "little") + h(d["type_id_code_hash"])
assert len(out) == 102, len(out)
open(sys.argv[2], "wb").write(out)
PY
  fi
fi

# 5. manifest
TPL="$ROOT/service/manifests/crt-local.toml.in"
[ -f "$TPL" ] || { [ "$DRY" = 1 ] && TPL=/dev/null || { curl -fsSL "https://raw.githubusercontent.com/$REPO/main/service/manifests/crt-local.toml.in" -o "$WORK/crt-local.toml.in"; TPL="$WORK/crt-local.toml.in"; }; }
MANIFEST="$WORK/crt-local.toml"
render() { sed -e "s|@R@|$R|g" -e "s|@ELF@|$ELF|g" -e "s|@DATA@|$DATA|g" "$TPL"; }
if [ "$DRY" = 1 ]; then echo "[dry-run] manifest $MANIFEST:"; render | sed 's/^/    /'
else render > "$MANIFEST"; fi

# 6. register, approve, enable (all three are no-ops when repeated)
if [ "$DRY" = 1 ]; then
  echo "[dry-run] $CSR service add-local --manifest $MANIFEST"
  echo "[dry-run] $CSR service approve <code hash>"
  echo "[dry-run] $CSR service enable <code hash>"
  CODE_HASH=0x...
else
  CODE_HASH=$("$CSR" service add-local --manifest "$MANIFEST" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["code_hash"])')
  "$CSR" service approve "$CODE_HASH"
  "$CSR" service enable "$CODE_HASH"
  echo "$CODE_HASH" > "$WORK/code_hash"
fi

# 7. CRT service ID (spec/service-manifest.md §4):
#    blake2b256("CSR-SERVICE-v1" || code_hash || u32le len(args) || args || u8 n || data_hash_1)
if [ "$DRY" = 0 ]; then
  SID=$(python3 -I - "$ELF" "$DATA" "$R" <<'PY'
import hashlib, sys
b = lambda d: hashlib.blake2b(d, digest_size=32, person=b"ckb-default-hash").digest()
elf, data = (open(p, "rb").read() for p in sys.argv[1:3])
r = bytes.fromhex(sys.argv[3][2:])
print("0x" + b(b"CSR-SERVICE-v1" + b(elf) + len(r).to_bytes(4, "little") + r + bytes([1]) + b(data)).hex())
PY
)
  echo "CRT service ID: $SID"
  echo "Runner lock hash R: $R"
fi
case "$NETWORK" in
  testnet) echo "Check the Jobs page of your dashboard (http://127.0.0.1:8114 by default; see csr.toml [dashboard].bind) for CRT jobs." ;;
  *) echo "Check the Jobs page of your dashboard (see csr.toml [dashboard].bind) for CRT jobs." ;;
esac
