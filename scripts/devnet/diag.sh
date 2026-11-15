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
