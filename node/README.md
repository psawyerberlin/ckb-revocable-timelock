# `node/` — the node contract

**No code here yet.** This file is the interface a CRT node must implement. It is written so that a node and a coordinator can be built independently, by different people, in different languages, and still interoperate. Read [`../SPEC.md`](../SPEC.md) first.

Paired document: [`../coordinator/README.md`](../coordinator/README.md).

---

## 1. What a node is

An independent operator that, for a fee, generates one secp256k1 keypair per switch, holds the private key, watches CKB for the switch's condition, and then either publishes the private key (release) or deletes it (cancellation).

A node holds **no user data**, has **no idea what it is protecting**, and cannot tell whether it is mandatory or how many peers it has ([SPEC §6.3](../SPEC.md#63-nodes-are-blind-to-the-tree)).

## 2. What a node must never do

| Rule | Why |
|---|---|
| Never derive a per-condition key from a master secret | A derived key cannot be deleted; cancellation would be a lie ([SPEC §5.1](../SPEC.md#51-per-condition-keypairs)) |
| Never use its own wall clock in the predicate | Chain `median_time` only, or premature release is unprovable ([SPEC §4.3](../SPEC.md#43-predicate)) |
| Never trust the coordinator for chain state | A node runs or contracts its **own** CKB RPC access |
| Never accept a user-supplied predicate script | Nodes must reach identical verdicts ([SPEC §4.5](../SPEC.md#45-custom-scripts)) |
| Never publish a release value before the predicate holds at ~30 confirmations | Slashable |
| Never reveal peer or tree information it doesn't have | It has none; if it appears to, something upstream leaked |

## 3. On-chain registration

A node registers **itself**. The coordinator writes nothing on-chain on a node's behalf.

Registration cell carries at least:

- node identity public key (secp256k1) — the key that signs everything in §4
- endpoint URL(s)
- stake (bonded)
- advertised fee per switch-year and minimum term
- declared jurisdiction / host / ASN (self-declared, for concentration analysis)
- exit notice field, empty until the node announces closure

The node pays its own network fees, for registration and for every claim.

## 4. HTTP API v1 (sketch)

All responses JSON. All signatures secp256k1 by the node's registered identity key. Domain-separated hashes as shown; the `TMN/v1` prefix is [open question O-7](../SPEC.md#13-open-questions).

### `GET /v1/info`

Static-ish node metadata. No auth.

```json
{
  "protocol": "crt/0.1",
  "node_id": "0x…",
  "identity_pubkey": "0x…",
  "networks": ["ckb_mainnet"],
  "fee_ckb_per_year": 150,
  "min_term_days": 90,
  "min_fee_ckb": 400,
  "accepting_new_switches": true,
  "exit_notice": null,
  "software": "crt-node/0.1.0"
}
```

### `POST /v1/switch`

Request a per-condition keypair. Idempotent on `I`: a repeated request for the same `I` returns the **same** public key, never a new one.

Request:

```json
{ "network_id": "ckb_mainnet", "type_id": "0x…", "identity": "0x…", "job_cell": "0x…" }
```

The node verifies independently that `identity == blake2b256("TMN/v1/cell" || network_id || type_id)` and that the Job Cell is funded to at least its advertised fee for the requested term. It does not take the coordinator's word for either.

Response:

```json
{
  "identity": "0x…",
  "condition_pubkey": "0x…",
  "signature": "0x…",
  "accepted_until": 1789…
}
```

where

```
signature = sign_identity( blake2b256("TMN/v1/pubkey" || network_id || I || condition_pubkey) )
```

**This signature is what the client hard-fails on** ([SPEC §8.4](../SPEC.md#84-client-hard-fail)). Get the preimage wrong and every client rejects the node.

### `GET /v1/release/{I}`

Before the predicate holds: `409` with the node's current view of the condition. After: the release value.

```json
{ "identity": "0x…", "condition_privkey": "0x…", "observed_block": "0x…", "signature": "0x…" }
```

The private key is self-verifying against the published public key, so the signature here is for attribution, not security.

### `GET /v1/health`

Liveness, current chain tip as seen by the node, lag. Used by watchtowers and by the directory.

### `GET /v1/switch/{I}/status` — **contested**

Whether the node serves `I` and its view of the condition. This endpoint is [open question O-5](../SPEC.md#13-open-questions): it makes independent auditing possible and it makes enumeration of a switch's node set possible. Do not implement it as unauthenticated until O-5 is closed.

## 5. Key lifecycle

```
  accept  ──▶  generate (CSPRNG, per-condition)  ──▶  hold
                                                       │
                     quarterly: PoP + claim  ◀──────────┤
                                                       │
        predicate satisfied ──▶ publish privkey ──▶ claim completion ──▶ delete
        cell consumed       ──▶ delete keys      ──▶ claim completion
```

Deletion means deletion from every copy, including backups and cold storage. That it is unverifiable is stated openly in [SPEC §3.2](../SPEC.md#32-what-crt-does-not-defend-against) — the honesty is the point, not a disclaimer to be softened.

## 6. Chain watching

- The node watches for: Alive Cells with `type-id` it serves, consumption of those cells, and Job Cell funding changes.
- Predicate evaluation at **~30 confirmations** against `median_time`.
- A node behind on chain tip is a liveness failure, reported by `/v1/health` and scored by the directory.

## 7. Fees

Schedule and proof-of-possession are in [SPEC §11.2–11.3](../SPEC.md#112-claim-schedule). Two implementation requirements:

- **Batching is mandatory for v0.1.** One claim transaction per node per quarter, covering all switches. Per-switch claims lose to network fees.
- The quarterly PoP signs `blake2b256("TMN/v1/pop" || T || block_hash(H))` with the **per-condition** key, so a node that has lost or deleted a key fails the claim rather than failing the release.

## 8. Exit

On-chain notice, keep serving through the notice period, unbond only afterwards ([SPEC §9.4](../SPEC.md#94-node-exit)). A node that disappears without notice should expect its stake slashed and its history to follow its operator.

## 9. Operator expectations — read this before running one

At reference pricing a node earns roughly **150 CKB per switch-year**. At launch volumes that is not income. Running a node early is a contribution to the network, and anyone telling you otherwise is selling something ([SPEC §11.4](../SPEC.md#114-reference-pricing)).

## 10. Open items for implementers

- Wire format and canonical JSON serialisation for signed payloads — undecided.
- Key storage requirements: HSM? Encrypted at rest with what? Undecided.
- Rate limiting and abuse controls on `POST /v1/switch` when the Job Cell check is the only gate.
- Whether `/v1/release/{I}` should also be served over a gossip transport at v0.1 or v0.2.
