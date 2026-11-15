#!/usr/bin/env bash
# Prints the CKB testnet address and balance of a deployer key file (never prints the key).
# Usage: testnet-address.sh --key-file FILE [--csr DIR] [--rpc URL]
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
KEY=""; CSR_DIR="$ROOT/.refs/csr"; RPC=https://testnet.ckb.dev/
while [ $# -gt 0 ]; do
  case "$1" in
    --key-file) KEY="$2"; shift ;;
    --csr) CSR_DIR="$2"; shift ;;
    --rpc) RPC="$2"; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$KEY" ] && [ -f "$KEY" ] || { echo "--key-file FILE is required" >&2; exit 2; }
CSR_DEV="$CSR_DIR/target/debug/csr-dev"
[ -x "$CSR_DEV" ] || { echo "missing $CSR_DEV (cargo build -p csr-dev in $CSR_DIR)" >&2; exit 1; }
export CSR_DEV_TESTNET_KEY="$(tr -d '[:space:]' < "$KEY")"
ARGS=$("$CSR_DEV" --rpc "$RPC" --json owner-lock-args | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["lock_args"])')
python3 -I - "$ARGS" "$RPC" <<'PY'
import sys, json, urllib.request
args, rpc = sys.argv[1], sys.argv[2]
CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
def polymod(values):
    gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
    chk = 1
    for v in values:
        b = chk >> 25
        chk = (chk & 0x1ffffff) << 5 ^ v
        for i in range(5):
            chk ^= gen[i] if (b >> i) & 1 else 0
    return chk
def convert(data, f, t):
    acc = bits = 0; out = []
    for v in data:
        acc = acc << f | v; bits += f
        while bits >= t:
            bits -= t; out.append((acc >> bits) & ((1 << t) - 1))
    if bits: out.append((acc << (t - bits)) & ((1 << t) - 1))
    return out
hrp = "ckt"
code_hash = "9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8"  # secp256k1_blake160_sighash_all
payload = bytes([0x00]) + bytes.fromhex(code_hash) + bytes([0x01]) + bytes.fromhex(args.removeprefix("0x"))
data = convert(payload, 8, 5)
hrpexp = [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]
pm = polymod(hrpexp + data + [0] * 6) ^ 0x2bc830a3  # bech32m
chk = [(pm >> 5 * (5 - i)) & 31 for i in range(6)]
print("address:", hrp + "1" + "".join(CHARSET[d] for d in data + chk))
body = json.dumps({"id": 1, "jsonrpc": "2.0", "method": "get_cells_capacity", "params": [{
    "script": {"code_hash": "0x" + code_hash, "hash_type": "type", "args": "0x" + args.removeprefix("0x")},
    "script_type": "lock"}]}).encode()
try:
    r = json.load(urllib.request.urlopen(urllib.request.Request(rpc, body, {"Content-Type": "application/json"}), timeout=30))
    cap = int(r["result"]["capacity"], 16)
    print(f"balance: {cap / 1e8:,.2f} CKB (needs about 53,000)")
except Exception as e:
    print("balance: could not read it:", e)
PY
