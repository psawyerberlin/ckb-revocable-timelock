#!/usr/bin/env node
// Helper for scripts/devnet-service-smoke.sh. Plain JSON-RPC, no dependencies besides csr-job.mjs (copied from the
// CSR checkout). NOT RUN in the authoring environment (no devnet); exercised in the crt-devnet-e2e manual phase.
//
//   crt-smoke.mjs --rpc URL <command> [args]
//   tip                                   print {number, timestamp_ms}
//   mine-to <unix-seconds>                mine blocks (via devnet.sh) until the tip timestamp >= value
//   node-state <T-hex> <R-hex> <codehash> print the state byte of the Node Cell with lock args T||R (or "none")
//   cell-live <type-id-args> <typecodehash> print "live" or "dead" for the Alive Cell (type-id script)
//   build-switch --spec FILE              print an unsigned create-transaction JSON (see buildSwitch)
//   send FILE                             send a signed transaction, print its hash
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blake2b256 } from './csr-job.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
let rpcUrl = 'http://127.0.0.1:18114';
if (args[0] === '--rpc') { rpcUrl = args[1]; args.splice(0, 2); }
const [cmd, ...rest] = args;

async function rpc(method, params = []) {
  const r = await fetch(rpcUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}
const hex = (b) => '0x' + Buffer.from(b).toString('hex');
const unhex = (h) => Buffer.from(h.replace(/^0x/, ''), 'hex');
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

async function tip() {
  const h = await rpc('get_tip_header');
  return { number: parseInt(h.number, 16), timestamp_ms: parseInt(h.timestamp, 16) };
}

// Node Cell data, SPEC §3.2 (139 bytes), state 0 (created).
export function nodeCellData({ deadline, ownerLockHash }) {
  const d = Buffer.alloc(139);
  d[0] = 1; d[1] = 0;
  u64le(deadline).copy(d, 2);
  unhex(ownerLockHash).copy(d, 10);
  return hex(d);
}

async function findCells(script, scriptType, mode) {
  const out = await rpc('get_cells', [
    { script, script_type: scriptType, script_search_mode: mode }, 'asc', '0x64']);
  return out.objects;
}

async function main() {
  switch (cmd) {
    case 'tip': console.log(JSON.stringify(await tip())); break;
    case 'mine-to': {
      const want = Number(rest[0]) * 1000;
      const devnet = resolve(here, '../../.refs/csr/scripts/devnet.sh');
      for (let i = 0; i < 2000; i++) {
        if ((await tip()).timestamp_ms >= want) { console.log('reached'); return; }
        // devnet.sh mines with wall-clock timestamps; when the target is in the future relative to the wall
        // clock the script must be run with a devnet whose miner honours CKB_DEVNET_TIME_OFFSET (see the shell
        // script); we simply mine in batches and re-check.
        execFileSync('bash', [devnet, 'mine', '5'], { stdio: 'ignore' });
      }
      throw new Error('tip timestamp did not reach target');
    }
    case 'node-state': {
      const [t, r, codeHash] = rest;
      const cells = await findCells({ code_hash: codeHash, hash_type: 'data2', args: t + r.replace(/^0x/, '') }, 'lock', 'exact');
      if (!cells.length) { console.log('none'); return; }
      const data = await rpc('get_live_cell', [cells[0].out_point, true]);
      console.log(unhex(data.cell.data.content)[1]);
      break;
    }
    case 'cell-live': {
      const [typeArgs, typeCodeHash] = rest;
      const cells = await findCells({ code_hash: typeCodeHash, hash_type: 'type', args: typeArgs }, 'type', 'exact');
      console.log(cells.length ? 'live' : 'dead');
      break;
    }
    case 'send': {
      const tx = JSON.parse(readFileSync(rest[0], 'utf8'));
      console.log(await rpc('send_transaction', [tx, 'passthrough']));
      break;
    }
    case 'owner-lock-hash': {
      // blake2b256 of the molecule-encoded script {code_hash, hash_type, args} given as JSON
      const s = JSON.parse(rest[0]);
      const ht = { data: 0, type: 1, data1: 2, data2: 4 }[s.hash_type];
      const args = unhex(s.args);
      const le32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
      const argsB = Buffer.concat([le32(args.length), args]);
      const total = 4 + 12 + 32 + 1 + argsB.length;
      const hdr = Buffer.concat([le32(total), le32(16), le32(48), le32(49)]);
      console.log(hex(blake2b256(Buffer.concat([hdr, unhex(s.code_hash), Buffer.from([ht]), argsB]))));
      break;
    }
    default:
      console.error('usage: crt-smoke.mjs [--rpc URL] tip|mine-to|node-state|cell-live|send|owner-lock-hash ...');
      process.exit(2);
  }
}
main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
