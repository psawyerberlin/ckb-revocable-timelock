#!/usr/bin/env bash
# Diagnostics for a runner that does not pick up CRT jobs. Usage: bash scripts/devnet/diag.sh [runner-number]
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; I="${1:-1}"; RD="$ROOT/.devnet/e2e/runner$I"; RPC=http://127.0.0.1:18114
rpc() { curl -fsS -X POST -H 'content-type: application/json' --data "{\"id\":1,\"jsonrpc\":\"2.0\",\"method\":\"$1\",\"params\":${2:-[]}}" "$RPC"; }
echo "== clocks"; echo "wall  $(date -u +%s)"; rpc get_tip_header | python3 -I -c 'import json,sys; h=json.load(sys.stdin)["result"]; print("tip  ", int(h["timestamp"],16)//1000, "block", int(h["number"],16))'
echo "== runner $I identity"; "$RD/csr" identity --json 2>&1 | head -c 600; echo
echo "== service commands"; "$RD/csr" service --help 2>&1 | head -20
echo "== service list"; "$RD/csr" service list 2>&1 | head -30
echo "== crt dir"; ls -la "$RD/crt"; cat "$RD/crt/code_hash" 2>/dev/null; echo; cat "$RD/crt/crt-local.toml" 2>/dev/null
echo "== deployment"; python3 -I -c 'import json;d=json.load(open("'"$ROOT"'/deployments/devnet.json"));print({k:d[k] for k in ("crt_code_hash","crt_data_hash")}); print(d["csr"]["job_lock"], d["csr"]["job_type"])'
echo "== expected service id of this runner (client formula)"
cd "$ROOT/client" && ./node_modules/.bin/tsx -e '
import { readFileSync } from "node:fs"; import { execFileSync } from "node:child_process";
import * as crt from "./src/index.ts";
const d = crt.parseDeployment(JSON.parse(readFileSync("../deployments/devnet.json","utf8")));
const id = JSON.parse(execFileSync("'"$RD"'/csr",["identity","--json"],{encoding:"utf8"}));
console.log(crt.crtServiceId(d, id.runner_lock_hash));' 2>&1 | tail -3
echo "== runner log (all lines after start)"; wc -l "$RD/csr.log"; grep -v "INFO csr::monitor" "$RD/csr.log" | tail -25 | cut -c1-220
echo "== service id the runner derives (crt-enable.sh formula) vs the job cells on chain"
python3 -I - "$ROOT" "$RD" <<'PY'
import hashlib, json, sys, urllib.request
root, rd = sys.argv[1], sys.argv[2]
b = lambda d: hashlib.blake2b(d, digest_size=32, person=b"ckb-default-hash").digest()
d = json.load(open(root + "/deployments/devnet.json"))
elf = open(root + "/service/build/crt-service.elf", "rb").read()
data = open(root + "/.devnet/e2e/deployment-devnet.bin", "rb").read()
R = bytes.fromhex(json.load(open(rd + "/crt/runner.json"))["R"][2:]) if False else None
import subprocess
ident = json.loads(subprocess.check_output([rd + "/csr", "identity", "--json"]))
R = bytes.fromhex(ident["runner_lock_hash"][2:])
sid = b(b"CSR-SERVICE-v1" + b(elf) + len(R).to_bytes(4, "little") + R + bytes([1]) + b(data))
print("elf hash          0x" + b(elf).hex(), "(deployment crt_code_hash %s)" % d["crt_code_hash"])
print("data file hash    0x" + b(data).hex(), "(deployment crt_data_hash %s)" % d["crt_data_hash"])
print("runner service id 0x" + sid.hex())
lock = d["csr"]["deployment"]["scripts"]["job_lock"]["code_hash"]
key = {"script": {"code_hash": lock, "hash_type": "data2", "args": d["csr"]["deployment"]["registry_type_hash"]}, "script_type": "lock", "with_data": False}
req = urllib.request.Request("http://127.0.0.1:18114", json.dumps({"id": 1, "jsonrpc": "2.0", "method": "get_cells", "params": [key, "asc", "0x64", None]}).encode(), {"content-type": "application/json"})
r = json.load(urllib.request.urlopen(req))
objs = r["result"]["objects"]
print("job cells under the job lock:", len(objs))
for o in objs[:12]:
    t = o["output"].get("type")
    print("  block", int(o["block_number"], 16), "type args", t["args"] if t else None)
PY
