#!/usr/bin/env python3
"""Builds the deployment data cell and writes deployments/<network>.json (schema: client/src/chain/deployment.ts).

  deployment.py data-bin --network-id N --node-lock-json FILE --type-id-hash 0x.. --out FILE
      the 102-byte CRT deployment data cell (SPEC.md 5.5): version 1, network id, node-lock code hash, node-lock out point,
      type-id code hash.
  deployment.py write --network NAME --network-id N --rpc URL --monitor-url URL --node-lock-json FILE --data-json FILE
                      --data-bin FILE --service-elf FILE --csr-deployment FILE --type-id-hash 0x.. --out FILE
      the complete deployment file. *-json files are `csr-dev --json deploy-service` outputs ({code_hash, tx_hash, index}).
"""
import argparse, hashlib, json, os, sys


def ckb_hash(b: bytes) -> str:
    return "0x" + hashlib.blake2b(b, digest_size=32, person=b"ckb-default-hash").hexdigest()


def hx(s: str) -> bytes:
    return bytes.fromhex(s[2:] if s.startswith("0x") else s)


def load(p):
    with open(p) as f:
        return json.load(f)


def data_bin(a):
    nl = load(a.node_lock_json)
    out = bytes([1, a.network_id]) + hx(nl["code_hash"]) + hx(nl["tx_hash"]) + int(nl.get("index", 0)).to_bytes(4, "little") + hx(a.type_id_hash)
    assert len(out) == 102, len(out)
    with open(a.out, "wb") as f:
        f.write(out)


def write(a):
    nl, dc = load(a.node_lock_json), load(a.data_json)
    data = open(a.data_bin, "rb").read()
    assert ckb_hash(data) == dc["code_hash"].lower(), "data cell hash differs from the deployed cell"
    csr = load(a.csr_deployment)
    s = csr["scripts"]
    ref = lambda x: {"code_hash": x["code_hash"], "out_point": {"tx_hash": x["tx_hash"], "index": x["index"]}}
    d = {
        "network": a.network, "network_id": a.network_id, "enabled": True,
        "node_lock": {"code_hash": nl["code_hash"], "hash_type": "data2", "out_point": {"tx_hash": nl["tx_hash"], "index": nl.get("index", 0)}},
        "crt_code_hash": ckb_hash(open(a.service_elf, "rb").read()),
        "crt_data_hash": dc["code_hash"],
        "crt_data_cell": {"tx_hash": dc["tx_hash"], "index": dc.get("index", 0)},
        "csr": {
            "job_type": ref(s["job_type"]), "job_lock": ref(s["job_lock"]),
            "registry_type_hash": csr["registry_type_hash"],
            # contracts v3: the registry's type args are the config cell's type args (spec/registry.md section 2)
            "registry_type_script": {"code_hash": s["registry"]["code_hash"], "hash_type": "data2", "args": csr["config_cell"]["type_args"]},
            "deployment": csr,
        },
        "type_id_code_hash": a.type_id_hash,
        "rpc_urls": [a.rpc], "monitor_url": a.monitor_url,
    }
    tmp = a.out + ".tmp"
    with open(tmp, "w") as f:
        json.dump(d, f, indent=2); f.write("\n")
    os.replace(tmp, a.out)


p = argparse.ArgumentParser()
sub = p.add_subparsers(dest="cmd", required=True)
b = sub.add_parser("data-bin")
b.add_argument("--network-id", type=int, required=True); b.add_argument("--node-lock-json", required=True)
b.add_argument("--type-id-hash", required=True); b.add_argument("--out", required=True)
w = sub.add_parser("write")
for k in ("network", "rpc", "monitor-url", "node-lock-json", "data-json", "data-bin", "service-elf", "csr-deployment", "type-id-hash", "out"):
    w.add_argument("--" + k, required=True)
w.add_argument("--network-id", type=int, required=True)
a = p.parse_args()
{"data-bin": data_bin, "write": write}[a.cmd](a)
