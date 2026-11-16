# CKB Revocable Timelock (CRT) — Specification

**Version 0.2 (CSR edition). Status: normative for the v0.1 implementation. Supersedes SPEC v0.1-draft and the
concept note v0.3 (both kept under `docs/history/`).**

CRT is timelock encryption with a working cancel button. It hands out a public key now and a private key later,
and nothing else. This version of the specification builds CRT **on CSR (CKB Service Runner)**: a CRT node is a
CSR runner that has enabled the CRT service. CRT ships no node daemon, no node registry, no stake contract and no
node HTTP API of its own; CSR provides all four. What CRT adds is one lock script, one CKB-VM service, a client
library and two file formats.

Section numbers are stable from this version on (CONTRIBUTING.md). Changes against v0.1-draft are listed in §16.

---

## 1. Overview

| Operation | What happens on chain | What happens in the nodes |
|---|---|---|
| **Create** | The owner's wallet creates one **Alive Cell** (type-id `T`), one **Node Cell** per chosen runner and one CSR **job cell** per chosen runner, in one transaction. | Each runner's CRT service runs its job, generates a fresh secp256k1 key pair from the host CSPRNG, stores the private key in its encrypted service storage with a *delete-on-consume* rule bound to the Alive Cell, and writes the public key into its Node Cell. |
| **Arm** | The owner's wallet writes the `descriptor_hash` into every Node Cell. | Nothing. |
| **Hold** | Each runner's heartbeat job runs every `HEARTBEAT` blocks and is paid a tip per run. | The service checks the predicate; nothing is published. |
| **Release** | When `median_time ≥ deadline + GRACE` **and** the Alive Cell is still live, each runner's heartbeat run spends its Node Cell and recreates it with the **private key in the cell data**. The lock script verifies the private key against the public key and the `since` of the input. | The service deletes the private key after the release transaction is committed. |
| **Cancel** | The owner consumes the Alive Cell with no replacement. The predicate becomes permanently unsatisfiable (type-id `T` can never exist again). | CSR deletes every stored private key bound to that out point, even when the service is disabled (`delete_on_consume`). |

Three parties, as before:

1. **Owner wallet** — any CKB lock (JoyID, secp256k1, multisig, …). Owns the Alive Cell and the Node Cells; signs
   and sends every transaction that touches the switch (create, arm, renew, rewrap, cancel, reclaim).
2. **Runners** — CSR runners (`ckb-service-runner`): registered on chain with a Nervos DAO stake, ranked by the
   CSR Network Monitor, running the CRT service inside the CSR sandbox. They never sign anything for the switch
   except their own CSR run transactions.
3. **Coordinator** (optional, v0.2) — a web service that helps choose runners, mirrors descriptors and builds
   *unsigned* transactions. Fully bypassable: the reference client works against a bare CKB RPC.

Everything a client needs is public chain state. The release values are **in the chain forever** (cell data of a
committed transaction), so recovery needs no server and survives every runner going offline afterwards.

### 1.1 What CRT does not do

Encrypt, store or transport user data; manage recipients; send email; defend against a threshold-sized coalition
of runners; defend against a runner dishonest from the first day (deletion is unverifiable); replace a lost owner
wallet; make any post-quantum claim. Applications (see `docs/developers.md`, and the reference application
`dead-man-switch`) do the first two.

### 1.2 Relation to CSR

| CRT concept (v0.1-draft) | On CSR |
|---|---|
| Node registry, stake, slashing cells | CSR registry cell (`RegistryV3`), Nervos DAO stake, monitor attestation. No CRT cells. |
| Node HTTP API (`/v1/switch`, `/v1/release`) | None. Keygen and release are written on chain by the service's transaction skeleton. |
| Node daemon (`CRT-node`) | The CRT **service**: a RISC-V program run by `csr run` against `spec/host-interface.md`. |
| Per-condition key from a CSPRNG | `random_bytes` host call (7050), shipped in CSR 0.6.1. |
| Key deletion on cancel | `delete_on_consume(key, alive_cell_outpoint)` — host-enforced, works while the service is disabled. |
| Job Cell (fee escrow), quarterly PoP claims | CSR job cells: tips per heartbeat run are the retainer; the on-chain run transaction is the liveness proof. |
| Registry pool, organiser fee | Dropped (pool) / optional output (organiser fee, §11). |
| Fraud proofs, slashing | Out of scope for v0.1 (CSR defines no slashing). Premature release is prevented by consensus (`since`); off-chain leaks are unpreventable in any design. |

---

## 2. Constants and identifiers

| Name | Value | Notes |
|---|---|---|
| `PREFIX` | `CRT/v1` | Resolves O-7. The `TMN/v1` prefix of v0.1-draft is abandoned. |
| `GRACE` | 86 400 s (24 h) | Resolves O-8. Protocol constant, in the lock script. A separate **testnet-only rehearsal deployment** (`deployments/testnet-drill.json`) is built with the `drill` feature and uses 600 s; it has its own node lock code hash and CRT service, the deployment file states `grace_seconds`, and the client refuses any grace other than 86 400 s on mainnet. |
| `HEARTBEAT` | per switch, default 8 000 blocks (≈ 1 day); allowed 1 000–60 000 (≈ 3 h – 1 week) | `Every(k)` interval of the heartbeat job. A **switch parameter** chosen at Create together with `n`, `t` and the mandatory set (§6.2). The lock does not care. |
| `HEARTBEAT_TIP` | per switch, default 0.5 CKB; minimum 0.1 CKB | Tip per heartbeat run, also a switch parameter. Runners may refuse switches below their advertised minimum (§9). |
| `network_id` | `0` mainnet, `1` testnet, `2` devnet | Same byte as `RegistryV3.network`. |
| blake2b-256 | CKB default: 32-byte digest, personalization `ckb-default-hash` | Everywhere. |
| Type ID script | `code_hash 0x00000000000000000000000000000000000000000000000000545950455f4944`, `hash_type type` | CKB's system type-id script. |

```text
T  = args of the Alive Cell's type-id script (32 bytes)        — globally unique, unrecreatable once consumed
I  = blake2b256( "CRT/v1/cell" ‖ network_id ‖ T )              — switch identity, 32 bytes
R  = runner lock hash of a CSR runner (RegistryV3 dual-lock args[32..64], or the whole 32-byte args)
```

`I` excludes the deadline, so renewals never change descriptors or ciphertexts. `I` is the key under which a
runner's service stores the private key, and the AAD of every envelope (§7). Test vectors: `spec/vectors/identity.json`.

---

## 3. On-chain objects

Exactly three kinds of cell belong to a switch. Capacities are approximate (lock scripts of 53–97 bytes).

### 3.1 Alive Cell

* **Type:** type-id, `args = T`.
* **Lock:** the owner's lock. Nodes never evaluate it. Any lock works (multisig, executor key, DAO, time lock).
* **Data:** 4 bytes `43 52 54 01` (`"CRT"` ‖ version 1). **Immutable** — the Alive Cell is never updated, only
  created once and consumed once. Its out point is therefore stable for the life of the switch, which is what
  `delete_on_consume` needs (§6.4). The deadline is **not** here (change from v0.1-draft, §16).
* **Capacity:** ≈ 61–130 CKB, refunded on cancel.

**Cancellation** = a transaction with the Alive Cell as input and **no output whose type script is the type-id
script with args `T`**. Nothing else is cancellation.

### 3.2 Node Cell (one per runner)

* **Lock:** `crt-node-lock` (§4), `hash_type data2`, `args = T (32) ‖ R (32)`.
* **Type:** none.
* **Data:** fixed layout, 139 bytes:

```text
NodeCellData {
  version:          u8        // 1
  state:            u8        // 0 created, 1 armed (pubkey set), 2 released (privkey set)
  deadline:         u64 LE    // unix seconds; compared to the chain's median time through `since`
  owner_lock_hash:  [u8;32]   // who may take the owner path (§4.1)
  descriptor_hash:  [u8;32]   // zero until the arm transaction
  pubkey:           [u8;33]   // compressed secp256k1; zero in state 0
  privkey:          [u8;32]   // zero before state 2
}
```

* **Capacity:** 8 + 97 + 139 = **244 CKB**, refundable by the owner (owner path) at any time — including after
  release: the release value stays in chain history even when the cell is later destroyed.

The Node Cell is at the same time the **key commitment** (state 1), the **release record** (state 2) and the
only per-switch state the node reads (deadline). All `n` Node Cells of a switch carry the same `deadline`,
`owner_lock_hash` and `descriptor_hash`; the owner updates them together.

### 3.3 CSR job cells (one keygen job and one heartbeat job per runner)

Standard CSR job cells (`ckb-service-runner/spec/job-cell-standard.md`), built with `sdk/js/csr-job.mjs`:

| | Keygen job | Heartbeat job |
|---|---|---|
| `csr-job-type.args` | service ID of **this runner's** CRT service (§5.1) | same |
| `trigger` | `OnDemand` | `Every(HEARTBEAT)` — the switch's own interval |
| `remaining_runs` | 1 | `ceil(term_blocks / HEARTBEAT)` |
| `payload` | `"CRTS" ‖ 0x01 ‖ T` (37 bytes) | same |
| `tip_shannons` | `KEYGEN_TIP` (default 1 CKB) | `HEARTBEAT_TIP` (default 0.5 CKB) |
| `max_fee_shannons` | default 0.002 CKB | same |
| `max_cycles` | measured on devnet, default 70 M (the CSR runners' default limit; a job above it is skipped) | same |
| `expiry_block` | creation + ≈ 7 days | end of term + ≈ 7 days |
| `refund_lock_hash` | owner lock hash | owner lock hash |

The service does not distinguish the two jobs: every run executes the same state machine (§6) against chain
state. The keygen job only exists so that keygen happens within minutes rather than after the first
`HEARTBEAT` interval. Both jobs refund their unspent capacity to the owner when consumed.

Why one job per runner: CSR assigns no runner to a job — any registered runner may run any job of a service it
has approved. CRT needs *specific* runners, so each runner enables the CRT program with **its own `R` as service
args**; the service ID (`spec/service-manifest.md` §4) then differs per runner, and a job names exactly one
runner. Inside the sandbox the service reads `R` from its own script args (`load_script`) and the lock script
enforces it (§4.2), so no CSR change is needed for assignment.

---

## 4. The `crt-node-lock` script

Rust, `ckb-std`, `hash_type = data2`. Args: `T (32) ‖ R (32)`, else error 5. The script runs as a lock group;
every input of the group is checked. Rule order determines the error code.

### 4.1 Owner path

If any input of the transaction has `lock_hash == owner_lock_hash` of this cell's data: **everything is
allowed** (update deadline, write `descriptor_hash`, destroy, recreate). The owner's own signature is the
authorisation; the owner can only hurt the owner.

### 4.2 Node path

Otherwise, an input with `lock_hash == R` (the runner wallet cell of a CSR run transaction) must exist (error
15), and exactly one output must have the same lock script as this input (error 12), and that output must have no type script (error 14: otherwise a runner could attach a script that makes the cell unspendable for the owner). Let `in` be this input's
data and `out` the output's data, both valid `NodeCellData` (error 6). `out.capacity ≥ in.capacity` (error 13).
`version`, `deadline`, `owner_lock_hash`, `descriptor_hash` unchanged (error 11). Then by state:

| `in.state` → `out.state` | Conditions |
|---|---|
| 0 → 1 (**commit**) | `in.pubkey` all zero; `out.pubkey` 33 bytes with prefix `02` or `03`, not all zero; `out.privkey` all zero (error 20). |
| 1 → 2 (**release**) | `out.pubkey == in.pubkey`; `secp256k1_pubkey(out.privkey) == in.pubkey` (error 21); the input's `since` has the absolute-timestamp form (flags `0x40`) and `since_seconds ≥ in.deadline + GRACE` (error 22, wrong form error 8); a **cell dep** exists whose type script is the type-id script with `args == T` — the live Alive Cell (error 23). |
| anything else | error 24. |

The `since` check is what makes a premature release impossible to commit: consensus refuses the transaction
until the median time of the last 37 blocks has passed `deadline + GRACE`. The cell-dep check is what makes
release impossible after cancel: a dead cell cannot be a dep. The lock does not check that the dep's lock or
data mean anything — the type-id script already guarantees that only one cell with `args = T` can ever exist.

### 4.3 Error codes

| code | meaning |
|-----:|---------|
| 1–4 | syscall failure |
| 5 | args not 64 bytes |
| 6 | data not a valid `NodeCellData` (length 139, version 1, state ≤ 2) |
| 8 | release: `since` not absolute-timestamp form |
| 11 | node path changed `version`, `deadline`, `owner_lock_hash` or `descriptor_hash` |
| 12 | node path: not exactly one output with this lock script |
| 13 | node path: output capacity below input capacity |
| 14 | node path: the output Node Cell has a type script |
| 15 | node path: no input with lock hash `R` |
| 20 | commit: pubkey rules violated |
| 21 | release: `privkey` does not derive `pubkey` |
| 22 | release: `since` below `deadline + GRACE` |
| 23 | release: no live Alive Cell dep (type-id, args `T`) |
| 24 | node path: state transition not allowed |

### 4.4 What the lock does not do

Check `R` against the CSR registry (CSR's own job lock does that for the run transaction); check the heartbeat;
pay anything; verify the descriptor. It is ~300 lines and shares its parsing and EC code with the service
through the `crt-core` crate.

---

## 5. The CRT service (runs inside CSR)

### 5.1 Identity and installation

The CRT service is one RISC-V binary (`crt-service`, Rust, `ckb-std`, target `riscv64imac-unknown-none-elf`,
built like CSR's `services/rust/*`). Its data hash is `CRT_CODE_HASH`, published once per network as an on-chain
**service manifest** with empty args (so it appears in every runner's catalog with name, description and links;
nothing posts jobs to that generic ID).

A runner enables CRT with an **on-chain manifest** whose `args` is its own `R`. CSR derives the service ID from the
code hash, the args and the data cells only for on-chain manifests (a local manifest registers the bare code hash, so
job cells addressed to one runner would never match; verified on devnet). The publisher binding of CSR requires the
manifest lock to equal the code cell's lock, so the owner of the CRT code cell (the CRT operator) publishes one manifest
per runner with `scripts/crt-publish.sh` (`csr service publish --code-outpoint … --data-outpoint <deployment data cell>
--args R`) and lists it in `deployments/<network>-manifests/<R>.json`.

`scripts/crt-enable.sh` (runner admins, `docs/operators.md`) reads `R` from the runner, finds that file, runs
`csr service add-onchain --manifest <out point> --approve && csr service enable <service ID>` and prints the runner's
**CRT service ID** = `blake2b256("CSR-SERVICE-v1" ‖ CRT_CODE_HASH ‖ u32 LE 32 ‖ R ‖ 0x01 ‖ data hash of the deployment
data cell)`. Clients compute the same from the registry cell and the deployment file.

### 5.2 Inputs of a run

* `load_script().args` → `R` (32 bytes; any other length → result `bad_args`, exit 0, empty skeleton).
* `job_payload` → must be `"CRTS" ‖ 0x01 ‖ T` (37 bytes), else result `bad_payload`.
* `block_info` → `median_time_ms`.
* `cells_query(type-id script with args T, type)` → the Alive Cell out point, or none.
* `cells_query(crt-node-lock with args T ‖ R, lock)` → this runner's Node Cell out point, or none.
* `chain_read(0 / 1, out point)` → the Node Cell output and data.
* `kv_get(I)` → the stored private key, if any.

`I = blake2b256("CRT/v1/cell" ‖ network_id ‖ T)`; `network_id` comes from the data cell (§5.5).

### 5.3 State machine

```text
no Alive Cell                         → CANCELLED:  kv_delete(I); empty skeleton; result "cancelled"
no Node Cell for (T, R)               → DROPPED:    kv_delete(I); empty skeleton; result "dropped"
Node state 0, kv_get(I) missing       → KEYGEN:     d ← random_bytes(32) until 0 < d < n;  P ← d·G
                                                    kv_put(I, d); kv_mark_secret(I);
                                                    delete_on_consume(I, alive_cell_outpoint);
                                                    skeleton: Node Cell → state 1, pubkey P
Node state 0, kv_get(I) present       → RECOMMIT:   P ← d·G from the stored d (a previous commit tx failed);
                                                    same skeleton as KEYGEN (never generate a second key)
Node state 1, kv_get(I) missing       → LOST:       empty skeleton; result "key_lost"   (operator alarm)
Node state 1, median_time_ms/1000 < deadline + GRACE
                                      → HOLD:       empty skeleton; result "hold"
Node state 1, median_time_ms/1000 ≥ deadline + GRACE
                                      → RELEASE:    skeleton: Node Cell → state 2, privkey d,
                                                    input since = 0x40 ‖ (deadline + GRACE) seconds,
                                                    cell dep = Alive Cell; result "release"
Node state 2                          → DONE:       kv_delete(I); empty skeleton; result "done"
```

Rules:

* **Keys are generated only from `random_bytes`** (host CSPRNG). No derivation from the service key, no HKDF
  from any master secret: a derived key cannot be deleted.
* **One key per `I`, ever.** RECOMMIT reuses the stored key. The service never overwrites an existing `kv` entry
  for `I`.
* **Deletion.** The service deletes on DONE (after it has *seen* its own release committed — that is the next run
  that finds state 2), on CANCELLED and on DROPPED. Cancellation deletion does not depend on the service: the
  `delete_on_consume` rule set at keygen is executed by the CSR host when the Alive Cell dies, "even if the
  service is disabled".
* **Idempotent and race-safe.** Every branch may run any number of times; a lost race (another of the runner's own
  runs committed first) just lands in the next state. Runs are short: HOLD costs one `cells_query` and two
  `chain_read`s.
* **No wall clock.** Only `block_info.median_time` is consulted, and the lock's `since` is what decides.
* **Skeleton capacity.** The recreated Node Cell has exactly the input's capacity; the run fee comes from the job
  (CSR). The skeleton carries the `crt-node-lock` code cell as a cell dep (and the Alive Cell dep on release).
* **Result** (`result_put`, ≤ 64 bytes): `"CRT1" ‖ status byte ‖ T`, status `0 hold, 1 keygen, 2 recommit,
  3 release, 4 done, 5 cancelled, 6 dropped, 7 key_lost, 8 bad_args, 9 bad_payload`. Shown on the runner's Jobs
  page; nothing else leaves the runner.

### 5.4 Cycle budget

Measured on devnet (phase 05). Expected: HOLD < 2 M cycles; KEYGEN/RELEASE ≈ 10–40 M (one scalar
multiplication with `k256`, no_std). `max_cycles` of the job cells defaults to 70 M, the default `max_cycles_per_job` of CSR runners (a job asking for more is skipped); the devnet run measures what the service needs.

### 5.5 Deployment data cell

`CRT_CODE_HASH` must not depend on the network, so the per-network constants travel in one **data cell** named by
the manifest (`data_cells[0]`), 97 bytes:

```text
CrtDeployment { version u8 = 1, network_id u8, node_lock_code_hash [u8;32], node_lock_outpoint [u8;36],
                type_id_code_hash [u8;32] = 0x…545950455f4944 (hash_type type is implied) }
```

With a data cell the service ID is the composite form of `spec/service-manifest.md` §4 and includes
`data_hash_1`; `crt-enable.sh` and the client both compute it that way. The data hash is also pinned in
`deployments/<network>.json`.

---

## 6. Lifecycle (who signs what)

| Transaction | Inputs | Outputs | Signer |
|---|---|---|---|
| **Create** | owner cells | Alive Cell; `n` Node Cells (state 0, deadline, owner, `descriptor_hash = 0`); `n` keygen jobs; `n` heartbeat jobs; optional organiser fee; change | owner |
| **Commit** (×n) | runner wallet, keygen job, Node Cell_i | runner wallet + tip, job refund, Node Cell_i (state 1) | runner_i (CSR) |
| **Arm** | `n` Node Cells (state 1) | same, `descriptor_hash` set | owner |
| **Heartbeat** (×n, every `HEARTBEAT`) | runner wallet, heartbeat job | runner wallet + tip, heartbeat job (runs−1) | runner_i (CSR) |
| **Renew** | `n` Node Cells | same, new `deadline`; `n` new heartbeat jobs for the extension | owner |
| **Rewrap** | old Node Cells (destroyed), owner cells | new Node Cells for the new set (state 0), new keygen and heartbeat jobs; later a new Arm | owner |
| **Release** (×n) | runner wallet, heartbeat job, Node Cell_i (`since`) | runner wallet + tip, job, Node Cell_i (state 2) ; dep: Alive Cell | runner_i (CSR) |
| **Cancel** | Alive Cell, optionally all Node Cells | nothing with type-id `T`; refunds | owner |
| **Reclaim** | Node Cells (any state), expired jobs | owner | owner |

Notes:

* **Create is one transaction** (resolves gap 1 of the design review). Nothing in it depends on the nodes' keys;
  the keys come later into cells that already exist. The user can walk away after Create and lose nothing but
  the keygen tips.
* **Arm** is the second user transaction. Until it is sent, the switch is not usable for encryption (the client
  refuses to wrap a key to an unanchored descriptor). The client waits for all `n` Node Cells to reach state 1,
  verifies each (§8.3), builds the descriptor, then sends Arm.
* **Renewal does not touch the Alive Cell** (resolves gap 2). CSR job cells cannot be extended, so renewal posts
  new heartbeat jobs; the old ones run out on their own. Renew when about one `HEARTBEAT` of runs remains to
  avoid paying both; the client shows the overlap cost.
* **Rewrap** drops old runners by destroying their Node Cells (owner path). Each dropped runner's service finds
  no Node Cell on its next heartbeat → DROPPED → deletes the key. This deletion is service-enforced, not host-
  enforced; the host rule still deletes on cancel.
* **Release after cancel is impossible** (dep rule) and **cancel after release is harmless** (the value is in
  history).
* **Reorgs** (gap 3): a release is as final as its transaction. CSR's `delete_on_consume` acts on observing the
  consumed cell without a confirmation depth; a reorg that uncommits a cancel after the host deleted the key
  destroys the switch. Documented residual risk; a configurable depth is proposed to CSR as a follow-up.

### 6.1 Headroom

Reported separately, never averaged: `threshold headroom = armed_in_set − t`, `mandatory headroom =
armed_mandatory − j`. "Armed" = Node Cell in state 1 **and** the runner's last heartbeat run is younger than
`3 × HEARTBEAT` blocks (read from the heartbeat job cell's recreation history or the runner's registry
attestation). Overall headroom = minimum of the two.

### 6.2 Switch parameters

Everything the owner decides at Create, each with a default, all shown on one screen with the cost estimate
(§11.1) updating live:

| Parameter | Default | Range | What it trades |
|---|---|---|---|
| `deadline` / term | — | ≥ 1 day (≥ 30 min on testnet and devnet, client check only, for rehearsals); warning > 5 years | duration risk (§10) |
| `n`, `t` | 8, 5 | `n` 3–16 (1–16 on testnet and devnet, `network_id` 1 and 2, where few runners exist), `1 ≤ t ≤ n`; warning `n < 5` | security vs cost: each runner costs its tips and its cells |
| mandatory set `j`-of-`m` | none | any subset of the `n`; `1-of-1` on > 1 year needs typed acknowledgement | harder to steal vs easier to lose, one for one |
| `HEARTBEAT` | 8 000 blocks | 1 000–60 000 | **detection delay vs cost**: a missing runner is noticed after ≈ 3 × `HEARTBEAT`; cost scales with `1 / HEARTBEAT` |
| `HEARTBEAT_TIP` | 0.5 CKB | ≥ 0.1 CKB | runner willingness: higher tips get picked up by more runners |
| `KEYGEN_TIP` | 1 CKB | ≥ 0.5 CKB | keygen latency |
| organiser fee | app-defined | ≥ 0 | nothing; a bypassable output |

Renew re-uses the switch's `HEARTBEAT` and `HEARTBEAT_TIP` unless the owner changes them (new heartbeat jobs
carry the new values; old jobs run out). Rewrap may change everything but `T`.

---

## 7. Keys, envelopes and access trees (client side)

Nodes are blind to all of this. They hold one key each and know nothing about thresholds, peers or mandatory
flags.

### 7.1 Secret and shares

* `K` = 32 random bytes (the application's content key or the key that wraps it).
* **Shamir `t`-of-`n`** over GF(2^8) (polynomial `0x11b`), byte-wise, `x = 1..n`. Share_i = `x (1 byte) ‖ y (32 bytes)`.
* **XOR** for AND: `K = K_A ⊕ K_B ⊕ …`, each branch itself a Leaf or a Threshold.
* **Share commitment** = `blake2b256("CRT/v1/share" ‖ share_i)`, in the descriptor, so a wrong release value is
  identified immediately.

### 7.2 Envelope `CRT-ENV-v1`

Wraps one share (or branch secret) `m` to a node's `pubkey P`:

```text
(e, E) ← fresh secp256k1 key pair
s     = x-coordinate of e·P                                   (32 bytes)
key   = HKDF-SHA256(ikm = s, salt = "CRT-ENV-v1", info = E ‖ P, L = 32)
nonce = 12 random bytes
ct    = AES-256-GCM(key, nonce, aad = I ‖ tree_position (u16 BE), m)
envelope = E (33) ‖ nonce (12) ‖ ct (|m| + 16)
```

Unwrapping with the released `d`: `s = x(d·E)`. Primitives: `@noble/secp256k1`, `@noble/hashes` (HKDF), WebCrypto
AES-GCM; the recovery kit inlines them (no network, no CDN).

### 7.3 Access tree

```json
{ "kind": "threshold", "t": 5, "n": 8, "leaves": [ {"node": 0}, {"node": 1}, … ] }
{ "kind": "xor", "branches": [ {"kind": "threshold", "t": 2, "n": 3, "leaves": […]},
                               {"kind": "threshold", "t": 5, "n": 8, "leaves": […]} ] }
```

`node` indexes `descriptor.nodes[]`. `tree_position` of a leaf = its index in a depth-first walk. v0.1 clients
MUST support `threshold` and `xor(threshold, threshold)`; mandatory branches are `threshold` with small `n`
(recommended `2-of-3`; `1-of-1` on a term > 1 year only with explicit acknowledgement). Effective control of a
runner appearing in several leaves is shown as such.

Standing trade, quoted at the point of choice: *every mandatory node makes the secret harder to steal and easier
to lose, one for one.*

---

## 8. Descriptor and recovery kit

### 8.1 Recipient descriptor

Signed by nothing (its anchor is the chain), canonicalised with JCS (RFC 8785):

```json
{
  "version": 1,
  "network_id": 1,
  "type_id": "0x…T…",
  "identity": "0x…I…",
  "created_at": 1763000000,
  "deployment": { "node_lock_code_hash": "0x…", "crt_code_hash": "0x…", "crt_data_hash": "0x…" },
  "alive_cell": { "tx_hash": "0x…", "index": 0 },
  "nodes": [
    { "runner_lock_hash": "0x…R…", "service_pubkey": "0x02…", "peer_id": "Qm…",
      "node_cell": { "tx_hash": "0x…", "index": 1 }, "pubkey": "0x02…", "label": "my own runner" }
  ],
  "access_tree": { … },
  "share_commitments": ["0x…", …],
  "coordinator_url": "https://crt.chainsolution.net"      // informational
}
descriptor_hash = blake2b256( "CRT/v1/descriptor" ‖ JCS(descriptor without descriptor_hash) )
```

The body is **never on chain** (it is a coalition targeting map). Only `descriptor_hash` is, in every Node Cell.
Envelopes are **not** part of the descriptor: the application produces them when it encrypts (§7.2) and stores
them with its ciphertext; the kit carries both.

### 8.2 Recovery kit (single HTML file)

`crt-kit.html`, generated from `{descriptor, envelopes, application?}`:

* a printable **certificate** page: creation time, deadline, network, tree diagram, node list with `R` and
  `pubkey`, `descriptor_hash`, Alive Cell out point, the release instructions in plain language for someone who
  has never heard of CKB;
* embedded `descriptor.json` and `envelopes.json` (`<script type="application/json">`);
* embedded zero-dependency recovery code: **(a)** online: query a CKB JSON-RPC (`get_cells` by lock script
  `crt-node-lock`, args prefix `T`) from a user-editable list (default: public nodes of the network), read every
  Node Cell in state 2, verify `pubkey(privkey) == pubkey`, unwrap, check commitments, combine → `K`; **(b)**
  offline: paste release values by hand;
* self-verification on open: recomputes `descriptor_hash` and shows MATCH / MISMATCH against the value printed on
  the certificate (and, online, against the Node Cells);
* an **application slot**: `window.CRT_KIT.application = {name, version, payload}` plus a `<script>` the
  application appends; the kit calls `window.crtApplication?.onKey(K)` after recovery and exposes
  `window.CRT_KIT.api = { readSwitch(), collectReleases(), recover(releases) }` and a `<div id="crt-application">`
  for the application's own UI, so an application never duplicates chain or recovery code. The `dead-man-switch`
  vault is a CRT kit with its ciphertext in the payload and a decrypt-and-show step in that hook.

Requirements: opens from a USB stick in 2040 (no CDN, fonts, frameworks or build-time URLs); prints legibly in
black and white; reproducible byte-for-byte from `{descriptor, envelopes, application}` with the same kit
version; smaller than 400 KB.

### 8.3 Hard-fail verification (client)

Before building a descriptor or wrapping a key, the client verifies for each node, **and refuses on any failure
with no override of any kind** (no flag, no config key, no "continue anyway"):

1. the Node Cell is live, its lock `code_hash` is the deployment's `node_lock_code_hash` with `hash_type data2`,
   its args are `T ‖ R`. The out point recorded in a descriptor is informational: Arm replaces every Node Cell, so
   the unique live cell with this lock is the Node Cell and the recorded pubkey (rule 3) binds it;
2. `R` is the runner lock hash of a live CSR registry cell (`RegistryV3`) with `network == network_id`; the
   registry's `service_pubkey` is the one recorded;
3. the cell is in state 1 with a valid compressed pubkey;
4. `deadline`, `owner_lock_hash` and (after Arm) `descriptor_hash` are identical across all `n` cells;
5. the Alive Cell is live with type-id args `T` and data `43525401`.

The chain itself guarantees that only runner `R` could have written the pubkey (§4.2), so no separate attestation
signature exists in v0.2.

---

## 9. Runner selection and the directory

The client (or the coordinator) builds its candidate list from public data only:

* CSR registry cells on the network (`get_cells` by the `csr-registry` type script): `R`, `service_pubkey`,
  `peer_id`, `stake`, `expiry_ms`, `endpoint`;
* the CSR Network Monitor public API (`spec/monitor-public-api.md`): rank, availability 7/30/365 d, `check_type`,
  `stake.status`, attestation status, coarse location;
* **CRT-specific**: whether the runner has the CRT service enabled — visible only through its behaviour. The
  client therefore keeps a public **CRT runner list** (`deployments/<network>-runners.json`, maintained by PR and
  mirrored by the coordinator) of runners that announced CRT, and marks each with observed performance: number of
  switches served (Node Cells with its `R`), median blocks from Create to Commit, heartbeat regularity. Every
  figure is recomputable from the chain.

A runner may publish, in `deployments/<network>-runners.json`, a minimum `HEARTBEAT_TIP` and a maximum `HEARTBEAT` it accepts; the client filters candidates by the switch parameters.

Selection defaults: only `stake.status == deposited` and `attestation.status == valid`; `check_type ==
p2p_verified` preferred; at most one runner per declared country/ASN cell; new runners marked *unproven*, not
penalised. Coalition risk (operator / ASN / country concentration of the chosen set) is shown before Create.

---

## 10. Monitoring and risk posture

| Term | Recommended structure |
|---|---|
| < 1 yr | threshold only, e.g. 5-of-8 |
| 1–3 yr | wider set, e.g. 6-of-12 |
| > 3 yr | wide set + 2-of-3 mandatory on owner-controlled runners, rewrap at every renewal; never 1-of-1 |

* **Descriptor rot** (runners leaving) is the principal long-term risk; repair = rewrap at renewal.
* **Withholding**: a runner that stops heartbeating or does not release loses only future tips. The threshold is
  the defence. A runner's heartbeat history is public (its job cell is recreated on chain each run), so
  withholding is visible early.
* **Premature release**: impossible on chain (`since`); off-chain leak of `d` is unverifiable and unpreventable in
  any design, including v0.1-draft's slashing (which only punished *on-chain* evidence).
* **Bootstrap**: "run your own CSR runner, enable CRT, mark it mandatory". Early security comes from the owner's
  runner; the network is defence in depth until `n` grows.
* **Quantum**: secp256k1, no PQ claim. Mandatory disclaimer at the deadline picker for terms > 5 years.

---

## 11. Economics

Reference at CKB = $0.01, defaults of §3.3, `HEARTBEAT` = 8 000 blocks ≈ 1 day.

| Item | Amount | Spent / locked |
|---|---|---|
| Keygen tip | 1 CKB per runner | spent |
| Heartbeat tip | 0.5 CKB per runner per run → ≈ 183 CKB per runner-year (365 runs, with fee) | spent |
| Organiser fee (optional output to the client/coordinator operator) | default 50 CKB per Create, 0 per Cancel | spent |
| Network fees | < 1 CKB per user transaction | spent |
| Alive Cell | ≈ 61–130 CKB | locked, back on cancel |
| Node Cell | 244 CKB per runner | locked, back on reclaim |
| Keygen job cell | ≈ 288 CKB per runner | locked for hours, back at commit minus tip |
| Heartbeat job cell | ≈ 295 CKB + 365 × 0.502 CKB per runner-year | locked, unspent part back at the end |

| Scenario (8 runners, 1 year) | CKB |
|---|---|
| Spent: 8 × (1 + 183) + 50 + fees | ≈ **1 530** (≈ $15) |
| Locked after commit (Alive + 8 × (244 + 295)) | ≈ **4 440** (≈ $44), refundable |
| Locked during the first hours (+ 8 × 288) | ≈ 6 740 |

### 11.1 Cost estimator (normative for clients and applications)

Every client shows the owner an estimate **before** Create, Renew and Rewrap, computed from the switch
parameters (§6.2) and the deployment's capacity constants — never a hard-coded table. With
`runs = ceil(term_blocks / HEARTBEAT)` and `term_blocks = term_seconds / block_seconds` (`block_seconds` from
the deployment file, 10 s on mainnet/testnet unless measured otherwise):

```text
per runner, over the term:   tips      = KEYGEN_TIP + runs × (HEARTBEAT_TIP + max_fee)
spent now:                   organiser_fee + network_fees
spent over the term:         n × tips                              (prepaid into the job cells, paid out per run)
parked (refundable):         alive_cell + n × (node_cell + keygen_job_occupied + heartbeat_job_occupied)
                             — keygen_job_occupied returns within hours; show it separately
monthly running cost:        spent over the term / term_months
detection delay:             3 × HEARTBEAT × block_seconds            (how long a silent runner goes unnoticed)
```

Capacity constants come from the cell layouts: `node_cell` = 8 + lock bytes + 139; job cells per CSR's
`minJobCapacity` (occupied + `runs × (tip + max_fee)`); `alive_cell` = 8 + lock bytes + 4. The estimator returns
every line in CKB and, when a fiat rate is supplied by the application, in fiat, and states the assumptions
(`block_seconds`, lock sizes). The reference values of the table above are the estimator's output for the
defaults and are checked by a test (`cost_estimate_defaults`).

Unspent prepaid tips (cancel before the term ends) return to the owner with the job cells.

A runner earns ≈ 183 CKB per switch-year; as in v0.1-draft, a launch-phase runner is a contribution, not income,
and `docs/operators.md` says so first. CSR's own costs (10 000 CKB DAO stake, 700 CKB runner wallet) are the
runner's and are documented by CSR.

Cancel carries no fee and is never harder in the UI than Create.

---

## 12. Threat model

Defends against: any sub-threshold set of dishonest runners; a malicious coordinator (it signs nothing, holds no
keys, and every datum it serves is verifiable against the chain); *later* compromise of an honest runner (the key
is gone after release or cancel); premature on-chain release (consensus); fake release values (lock verifies
`pubkey(d)`); descriptor tampering (hash on chain, in `n` cells).

Does not defend against: a threshold-sized coalition (design limit, mitigated by diversity scoring and per-switch
keys); a runner dishonest from the first day (it can copy `d` before storing it — deletion is unverifiable; the
client says so); runner closure beyond headroom (a lost mandatory runner is fatal; the UI shows it daily); loss
of the owner wallet; CSR host compromise on a runner (equivalent to a dishonest runner); the residual reorg risk
of §6.

Privacy: Node Cells reveal the runner set and the deadline of every switch (not the tree, not the thresholds,
not the mandatory flag). This resolves O-5 towards auditability: the set is public, the structure is not.

---

## 13. Components

| Directory | Language | Contents |
|---|---|---|
| `contracts/crt-core` | Rust `no_std` | `NodeCellData`, payload and identity helpers, secp256k1 pubkey derivation (`k256`), GF(2^8) is **not** here (client only) |
| `contracts/crt-node-lock` | Rust `ckb-std` | §4, tests with `ckb-testtool` |
| `service/crt-service` | Rust `ckb-std` (CSR service) | §5, unit tests of the state machine against a mock host, devnet integration |
| `client/` | TypeScript (ESM, browser + Node) | identity, access trees, envelopes, descriptor + JCS, hard-fail verification, CCC transaction builders, kit generator, offline recovery; conformance vectors |
| `web/` | TypeScript + the static `site/` | reference client UI at `crt.chainsolution.net/app` |
| `deployments/` | JSON | per-network code hashes, out points, CSR deployment references, CRT runner list |
| `scripts/` | bash | `crt-enable.sh` (operators), devnet end-to-end, release packaging |
| `coordinator/` | v0.2 | directory, mirror, unsigned tx service (spec in `coordinator/README.md`) |

Shared conformance vectors live in `spec/vectors/` and are checked by the Rust and the TypeScript test suites.

---

## 14. CSR requirements

CRT v0.1 needed exactly one change in CSR, shipped in CSR 0.6.1 (`spec/host-interface.md` there):

* **`random_bytes(addr, len)` (7050)**: fill `len ≤ 1024` bytes from the host's CSPRNG; local mode too. Return 0,
  11 when `len > 1024`, or 12 when `len = 0`.

Already present and relied on: `kv_*` with `kv_mark_secret` and `delete_on_consume`; `cells_query` (prefix match,
≤ 64 cells); `chain_read`; `block_info` median time; `tx_skeleton_put` with skeleton `since` and cell deps;
local manifests with `args`; composite service IDs with data cells.

Proposed, not required: a confirmation depth for `delete_on_consume`; `csr service add-onchain --args` so that an
operator can enable a catalog service with runner-specific args in one click.

---

## 15. Open questions

| Id | Question | Status |
|---|---|---|
| O-1 | Minimum viable runner set at launch | open; client refuses `n < 3` and warns below `n = 5` |
| O-2 | CKB price volatility on multi-year terms | resolved for v0.1: tips are fixed in CKB at creation; renew re-quotes |
| O-3 | Runner exit notice | inherited from CSR (registration removal); the heartbeat history shows a silent exit within 3 × `HEARTBEAT` |
| O-4 | Rewrap by an executor who may not release | open (executor lock on the Node Cells' owner path is possible: `owner_lock_hash` may be a multisig) |
| O-5 | Node privacy | resolved: set public, structure private (§12) |
| O-6 | Registry pool governance | dropped with the pool |
| O-7 | Prefix | resolved: `CRT/v1` |
| O-8 | `GRACE` | resolved: 24 h |
| O-9 | `delete_on_consume` without confirmation depth (reorg) | proposed to CSR |
| O-10 | Heartbeat overlap at renewal | accepted cost; a CSR `Every` job top-up would remove it |
| O-11 | Should the service also prove possession on chain at heartbeat (a signature with `d` in the result or a cell)? | deferred: costs capacity per run; the commit tx already proves the runner had `d` once, and release proves it had it at the end |

---

## 16. Changes from v0.1-draft and the concept note

* Built on CSR: no CRT node software, registry, stake, slashing or node API.
* Alive Cell is immutable; `deadline` and `descriptor_hash` moved to the Node Cells.
* Node Cell replaces the Job Cell merkle root, the per-condition pubkey attestation and the release endpoint.
* Keygen and release are on-chain transactions of the runner, enforced by `crt-node-lock`.
* Create is one transaction; Arm is a second user transaction (resolves gap 1).
* Heartbeat jobs replace quarterly PoP claims and the 10/80/10 schedule.
* Prefix `CRT/v1`, `GRACE` 24 h, section numbers frozen.
* Node API, coordinator API and `node/`, `coordinator/` contracts of v0.1-draft are historical; the coordinator
  is v0.2 and optional.
