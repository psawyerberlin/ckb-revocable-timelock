# `coordinator/` — the coordinator contract

**No code here yet.** This file defines what a CRT coordinator may do, what it must never do, and the API it exposes. Read [`../SPEC.md`](../SPEC.md) first.

Paired document: [`../node/README.md`](../node/README.md).

---

## 1. What a coordinator is

A web interface plus API that makes CRT usable: it finds nodes, assembles descriptors, builds unsigned transactions, watches switches, and aggregates release values.

It is **convenience infrastructure**. Any developer may run one. A user who wants none must still be able to create, renew, cancel and release a switch by talking to a CKB RPC endpoint and to nodes directly ([SPEC §8.5](../SPEC.md#85-standalone-operation)).

## 2. The hard rules

| Rule | Consequence if broken |
|---|---|
| **Never initiates a blockchain transaction.** It scans, and it builds *unsigned* transactions for the wallet | A coordinator that can transact can cancel or stall a user's switch |
| Never holds key material of any kind | It becomes the single point of compromise the whole design avoids |
| Never writes to the node registry on-chain | The directory must be independently recomputable by anyone |
| Never stores user contact details next to condition ids | It becomes a correlation target mapping identities to pending switches ([SPEC §9.3](../SPEC.md#93-closure-warnings)) |
| Its descriptor mirror is non-authoritative | The on-chain `descriptor_hash` is the only authority |

The Alive Cell is locked by the **user**, which is the structural reason none of the above is enforceable by trust alone — it isn't needed. A misbehaving coordinator is an inconvenience, not a loss.

## 3. Responsibilities

### 3.1 Node directory

Built by **scanning the chain and probing node endpoints**. Writes nothing on-chain.

Per-node fields: registered-since, stake, availability over 30 / 90 / 365 days, latency, switches served, missed PoP events, slash history, exit notice, jurisdiction / ASN / host, composite rating.

Directory rules, all four binding:

1. Every field independently recomputable from public data.
2. The rating formula is published and versioned. A rating you cannot recompute is marketing.
3. Multiple independent watchtowers, not one operator's word.
4. New nodes are marked **unproven**, not penalised. Otherwise no node can ever enter.

Network-wide **coalition risk** — concentration by operator, host, ASN, country — belongs on the front page, not on a sub-page. The whole security argument depends on it.

### 3.2 Descriptor assembly

The coordinator collects signed per-condition public keys from the chosen nodes and assembles the descriptor ([SPEC §7.1](../SPEC.md#71-recipient-descriptor)).

The **client** — not the coordinator — verifies every signature against the on-chain registry and hard-fails on any mismatch. The coordinator must not offer an endpoint, flag or parameter that lets a client skip this ([SPEC §8.4](../SPEC.md#84-client-hard-fail)).

### 3.3 Transaction building

Produces the unsigned three-output creation transaction: Alive Cell, Job Cell, organiser fee ([SPEC §11.1](../SPEC.md#111-creation-transaction)). Also unsigned renew, top-up and cancel transactions. The wallet signs and broadcasts every one of them.

Cancel must be offered with **no organiser fee** and must not be hidden behind a confirmation flow more onerous than create.

### 3.4 Monitoring and headroom

Publishes, per switch, `threshold headroom` and `mandatory headroom` **separately, never averaged**, with overall status equal to the minimum across branches ([SPEC §9.2](../SPEC.md#92-headroom-reporting)).

Exposes this **as data, with webhooks**. Applications notify their own users. The coordinator does not run a mailing list of people with pending dead man's switches.

### 3.5 Release aggregation

Polls node `/v1/release/{I}` endpoints after the predicate holds and serves the collected values. This is a convenience only: a recovery kit that can reach nodes directly must work with the coordinator offline or hostile ([SPEC §8.3](../SPEC.md#83-release-distribution)).

### 3.6 Recovery kit delivery

Generates the self-contained offline HTML kit ([SPEC §7.3](../SPEC.md#73-recovery-kit)) and keeps a mirror retrievable by wallet login. Kit generation must be reproducible from the descriptor alone, so a third party can regenerate it.

## 4. HTTP API v1 (sketch)

```
GET  /v1/nodes                      directory, with ratings and recompute inputs
GET  /v1/nodes/{node_id}            single node detail and history
GET  /v1/network/concentration      coalition risk by operator / host / ASN / country

POST /v1/switch/plan                → node selection + tree proposal for given params
POST /v1/switch/prepare             → unsigned creation tx + assembled descriptor
POST /v1/switch/renew               → unsigned renew tx
POST /v1/switch/cancel              → unsigned cancel tx (no fee)

GET  /v1/switch/{I}                 status, headroom (both figures), deadline
GET  /v1/switch/{I}/descriptor      mirror copy, non-authoritative
GET  /v1/switch/{I}/release         aggregated release values, once available
POST /v1/webhooks                   subscribe to headroom / status events
```

Nothing in this list accepts a private key, and nothing in it broadcasts.

## 5. The fee is bypassable and that is intentional

The organiser fee is a third output of a transaction the user's own wallet builds. A user who builds it themselves pays nothing, and nodes still serve the switch because a node checks only that the Job Cell is funded ([SPEC §11.5](../SPEC.md#115-the-organiser-fee-is-bypassable)).

Design implication for anyone running a coordinator: **your revenue is service, not gatekeeping.** Build accordingly.

## 6. Registry pool

The +20% surcharge funds watchtower bounties, liveness monitoring, reference hosting and audits. In v0.1 the founding operator controls it under a published policy. That is a centralisation point and the front page should say so, in those words ([SPEC §11.6](../SPEC.md#116-registry-pool)).

## 7. Open items for implementers

- Rating formula v1 — weights, decay, how missed PoP events are scored.
- Whether node probing needs authenticated watchtower attestations at v0.1 or later.
- Storage model for the descriptor mirror, and its deletion policy.
- Whether `/v1/switch/plan` should refuse to propose a 1-of-1 mandatory branch outright, or warn ([SPEC §6.2](../SPEC.md#62-mandatory-branches)).
