# CRT — Revocable Timelock on Nervos CKB

**Specification `v0.1-draft`.** Nothing here is implemented. Section numbers are stable; if you argue with a section, cite its number.

Earlier drafts of this design circulated as *TimeMachine Network (TMN)*. Domain-separation strings still carry the `TMN/v1` prefix; renaming them is [open question O-7](#13-open-questions) and must be settled before any string is frozen into a script.

---

## 1. The primitive

CRT provides exactly one operation and its inverse.

- **Create.** A user obtains a *recipient descriptor* now. The descriptor contains everything needed to derive a public key. Anyone can encrypt to it immediately.
- **Release.** Once a condition anchored on CKB is satisfied, nodes publish their private key parts. Anyone who can reach a threshold of them can reconstruct the decryption key. Release is public: after it happens, the data is decryptable by anybody who holds the ciphertext.
- **Cancel.** The owner consumes the on-chain cell. The condition becomes permanently unsatisfiable, nodes delete their key parts, and the data is unrecoverable forever.

That is the whole product surface. Everything below is how to make those three operations safe.

### 1.1 In scope

Descriptors; per-condition key custody; watching conditions; deleting keys; publishing release values; node registry and reputation; fee escrow.

### 1.2 Out of scope

Encrypting user data. Storing user data. Transporting user data. CRT hands out a public key and, later, a private key. What you wrap with it and where you keep the ciphertext is the application's problem. This is deliberate — see [§12](#12-relation-to-drand-and-to-sarcophagus).

Post-quantum security is also out of scope; see [§10](#10-quantum-posture).

---

## 2. Terminology

| Term | Meaning |
|---|---|
| **Switch** | One condition plus the set of node keys bound to it |
| **Alive Cell** | The CKB live cell whose existence encodes "not yet released, not cancelled" |
| **Job Cell** | The escrow cell funding node fees for one switch |
| **`T`** | 32-byte `type-id` of the Alive Cell |
| **`I`** | Condition identity, derived from `T` — the name nodes index by |
| **Per-condition keypair** | A fresh secp256k1 keypair a node generates for exactly one switch |
| **Release value** | The per-condition **private key**, published at release |
| **Descriptor** | Signed JSON describing a switch: `T`, `I`, access tree, node pubkeys, commitments |
| **Recovery kit** | Self-contained offline HTML file given to the user; certificate plus recovery tool |
| **Access tree** | The structure (thresholds, mandatory branches) combining node keys into one secret |
| **Coordinator** | A web interface plus API that organises switches. Convenience only |
| **Node** | An independent operator holding one key part per switch, for a fee |
| **`K`** | The reconstructed secret the access tree yields at release |

---

## 3. Threat model and trust assumptions

### 3.1 What CRT defends against

- **A minority of dishonest nodes.** Below the threshold, colluding nodes learn nothing usable.
- **A malicious coordinator.** The coordinator never holds key material, never signs a user transaction, and cannot cancel a switch. Substituting its own node public keys is caught by signature verification against the on-chain registry ([§8.4](#84-client-hard-fail)).
- **Later compromise of an honest node.** Because keys are per-condition and deleted at resolution, seizing a node's disk after a switch resolves yields nothing about that switch.
- **Premature release.** The predicate is evaluated against chain time only ([§4.3](#43-predicate)), so releasing early is objectively provable by anyone, not a matter of one node's word against another's.

### 3.2 What CRT does not defend against

- **A coalition at or above the threshold.** This is the stated design limit: there is intended to be no loophole *other than* a threshold-sized coalition of rogue nodes.
- **A node dishonest from the start.** Key deletion is unverifiable. A node that copies its key at generation time keeps it forever, and no protocol here detects that. Per-condition keys protect against *later* compromise of an honest node — nothing more. Say this to users plainly.
- **Node closure.** If a node vanishes without publishing, its share is gone. Above the threshold this is survivable; a lost mandatory node is fatal. See [§9](#9-duration-and-risk-posture).
- **The owner losing their wallet.** The Alive Cell is locked by the user. No wallet, no renewal, no cancel.

### 3.3 Parties

Three, and only three:

1. **User wallet** — JoyID or any CKB wallet. Signs and broadcasts every transaction that touches the user's switch.
2. **Nodes** — register themselves on-chain with stake, submit their own claim transactions, pay their own fees.
3. **Coordinator** — scans the chain and serves an API. **Never initiates a blockchain transaction.** It may build unsigned transactions for the wallet to sign.

---

## 4. Conditions

### 4.1 Alive Cell

A CKB live cell with:

- a standard **`type-id`** type script carrying a 32-byte id `T`;
- a **lock script chosen by the user** — any lock, including custom ones. Nodes never execute it and never care what it is;
- cell data containing at least `deadline` (chain time) and `descriptor_hash`.

The cell being locked by the user is what makes coordinator hostage-taking impossible.

### 4.2 Identity

```
I = blake2b256( "TMN/v1/cell" || network_id || T )
```

`deadline` is deliberately **excluded** from `I`. Renewal changes the deadline; if the deadline were in the identity, every renewal would invalidate every descriptor already handed out.

### 4.3 Predicate

A node considers the condition satisfied for `I` when, at a block `B` with roughly 30 confirmations:

1. a live cell with `type-id` equal to `T` exists on `network_id`; **and**
2. `deadline + GRACE <= median_time(B)`.

Node wall clocks are never consulted. `median_time` is the only clock in the protocol. `GRACE` is a protocol constant, not a per-switch parameter.

### 4.4 Cancellation

Cancellation is consuming the Alive Cell **without replacement**. `type-id` uniqueness means `T` can never be recreated, so condition (1) of the predicate is permanently false. Nodes observing the consumption delete their per-condition keys and may claim the completion portion of their fee ([§11.2](#112-claim-schedule)).

Cancellation costs the user no organiser fee. Charging to cancel would be an incentive to leave switches armed.

### 4.5 Custom scripts

Custom **lock** scripts on the Alive Cell are supported and free.

User-supplied **predicate** scripts are rejected. Nodes must all reach the same verdict from the same chain state; a per-switch predicate is a way for nodes to legitimately disagree, and disagreement breaks threshold recovery.

---

## 5. Key model

### 5.1 Per-condition keypairs

On accepting a switch, each node generates a **fresh secp256k1 keypair from a CSPRNG**, bound to exactly one `I`.

Deriving that key from a node master secret via HKDF is forbidden. A derived key cannot be deleted — the master secret regenerates it — so deletion would be theatre and cancellation would be a lie.

### 5.2 No DKG, no federation

Each node's key is independent. There is no distributed key generation and no group share. Two reasons, both fatal to the alternative:

- one successful collusion against a long-lived group share silently compromises **every ciphertext ever produced** against it, retroactively;
- a group share cannot be deleted, so cancellation is impossible by construction.

### 5.3 Release is disclosure, not signing

The release value is the per-condition **private key**, published verbatim. It is not a signature over anything.

This choice dropped BLS and IBE from the design entirely. Consequences:

- secp256k1 throughout, natively verifiable inside CKB scripts;
- no domain-confusion attack in which a node is induced to sign the release value before the deadline, because there is no release signature to induce.

### 5.4 Deletion

Deletion is unverifiable and the spec says so in [§3.2](#32-what-crt-does-not-defend-against). The nearest thing to a control is the quarterly proof of possession ([§11.3](#113-proof-of-possession)), which detects a node that has *stopped* holding a key — the opposite failure — early enough to rewrap.

---

## 6. Access trees

### 6.1 Composition

- **Shamir secret sharing** provides thresholds (`k`-of-`n`).
- **XOR** provides conjunction (AND).

A mandatory node is an XOR branch composed with a Shamir branch. "5-of-8 with one mandatory" therefore means: `M` **XOR** (4-of-7 over the remaining nodes).

### 6.2 Mandatory branches

A mandatory branch should itself be `j`-of-`m` — 2-of-3, say — never 1-of-1 on a multi-year term. A 1-of-1 mandatory branch is a single point of failure with a business behind it.

**Standing trade-off, to be quoted at users at the point of choice:** every mandatory node makes the secret harder to steal and easier to lose, one for one.

### 6.3 Nodes are blind to the tree

A node never learns the threshold, the identities of the other nodes, or whether it is mandatory. It receives a request for `I`, generates a key, returns a signed public key.

Two consequences:

- a coalition cannot shop for the mandatory node, because no node can tell it which one that is;
- new tree structures ship without touching node code. The tree lives in the descriptor and in the client.

---

## 7. Descriptor and recovery kit

### 7.1 Recipient descriptor

Signed JSON, roughly 2–6 KB. Entirely public and entirely non-secret. Contents:

- `network_id`, `T`, `I`
- the access tree
- one **signed per-condition public key per node**
- share commitments
- coordinator URL used at creation (informational)

### 7.2 The descriptor body is not on-chain

Only `descriptor_hash` goes into the Alive Cell, as an integrity anchor.

Publishing the body on-chain would hand any future coalition a targeting map naming every node serving the switch — including, by elimination over time, the mandatory one.

### 7.3 Recovery kit

The user downloads a **single self-contained HTML file** that acts as certificate, archive and offline recovery tool at once. It contains:

- the descriptor, `T`, `network_id`, creation and deadline timestamps
- the node list and a rendered diagram of the access tree
- instructions written for an heir who has never heard of CKB
- embedded zero-dependency recovery JavaScript

Hard requirements: it must open from a USB stick with no network, and it must print legibly on paper.

### 7.4 Coordinator mirror

The coordinator keeps a copy in its database, retrievable by wallet login. This copy is **non-authoritative** and verifiable against the on-chain `descriptor_hash`.

### 7.5 Key envelope is not CRT's

The wrapped blobs an application produces at encryption time — the key envelope — belong to the application and live beside its ciphertext. CRT never sees them.

---

## 8. Architecture

### 8.1 Coordinator

A web interface plus API. Scans the chain, maintains the node directory, assembles descriptors, aggregates release values, publishes headroom.

**Hard rule: the coordinator never initiates a blockchain transaction.** It scans, and it builds unsigned transactions. The user's wallet signs and broadcasts.

### 8.2 Nodes

Register on-chain with stake. Submit their own registration and claim transactions and pay their own network fees. Serve an HTTP API ([`node/README.md`](node/README.md)).

### 8.3 Release distribution

Nodes publish release values to **their own endpoints and by gossip**. The coordinator aggregates as a convenience and can be bypassed entirely. A recovery kit that can only reach the node endpoints must still work.

### 8.4 Client hard-fail

The client **must** verify each per-condition public key's signature against the node's key in the on-chain registry, and **must** abort if any verification fails.

This is non-optional. There is no skip flag, no "continue anyway" button, no configuration key that disables it. Without it, a malicious coordinator substitutes its own keys for the node keys and holds the entire secret.

### 8.5 Standalone operation

`crt-client` must work against a bare CKB RPC endpoint with no coordinator at all: build the transaction, talk to nodes directly, assemble the descriptor locally. See [§11.5](#115-the-organiser-fee-is-bypassable).

---

## 9. Duration and risk posture

The expected case is a deadline **under one year**. Multi-year is rare and the client must price the risk accordingly.

| Term | Recommended structure |
|---|---|
| Under 1 year | Threshold only, no mandatory node (default) |
| 1–3 years | Wider node set, more headroom |
| 3+ years | Wide set **plus** a 2-of-3 mandatory branch **plus** rewrap at every renewal |

### 9.1 Descriptor rot

The principal long-term risk is node closure. The repair is **rewrap at renewal**, which requires the owner to still be able to reach `K` — so the application stores `E(K)` under a wallet-derived wrapping key.

### 9.2 Headroom reporting

Two figures, **reported separately and never averaged**:

- `threshold headroom` — how many non-mandatory nodes can vanish before the threshold branch fails;
- `mandatory headroom` — the same for each mandatory branch.

Overall status is the **minimum** across branches. An average would report a switch as healthy while its mandatory branch was one closure from unrecoverable.

### 9.3 Closure warnings

The coordinator publishes headroom **as data**, with webhooks. Applications notify their own users.

The coordinator does not collect user email addresses. Storing contact details next to condition ids would turn the coordinator into a correlation target linking real identities to pending switches.

### 9.4 Node exit

A node must give **on-chain notice** before closing, keep serving through a mandatory notice period, and may unbond only after that period expires. <!-- TODO: notice period length is open question O-3 -->

---

## 10. Quantum posture

secp256k1 throughout. **No post-quantum claim is made.** This is defensible because the expected term is under a year.

The web interface must display a disclaimer **at the point where the user chooses a deadline** — not buried in terms of service — whenever the term exceeds five years, stating that secp256k1 is not quantum-resistant and that rewrap is the migration path.

---

## 11. Economics

### 11.1 Creation transaction

All CKB for creating a switch comes from the user's wallet, in **one transaction with three outputs**:

1. the Alive Cell,
2. the Job Cell (fee escrow),
3. the organiser service fee.

### 11.2 Claim schedule

**10% setup / 80% retainer vesting quarterly / 10% completion.**

Terms shorter than one quarter pay the retainer as a single payment at resolution.

The completion portion is claimable on release **only by a node that actually published its release value**, and is also released on **cancellation**. Without paying on cancellation, a node has no economic reason ever to delete anything.

### 11.3 Proof of possession

Each quarterly claim is gated on a proof of possession. The node signs

```
blake2b256( "TMN/v1/pop" || T || block_hash(H) )
```

with the per-condition private key. Because the message is chain-derived, it cannot be precomputed.

The point of the timing: this catches a node that deleted its cold keys at its **next quarterly claim** — months after defecting, while its stake is still bonded and while the user can still rewrap — instead of at release, when it is too late for everybody.

### 11.4 Reference pricing

At CKB = $0.01:

| Item | Amount |
|---|---|
| Node fee | 150 CKB per node per year (minimum term 3 months, minimum 400 CKB) |
| Registry pool | +20% surcharge |
| Organiser fee | 100 create / 50 renew / 50 top-up / **0 cancel** |
| Alive Cell | ~150 CKB (refundable capacity) |
| Job Cell overhead | ~130 CKB (refundable capacity) |
| **8 nodes, 1 year** | **≈ 1,541 CKB spent (~$15.40)** |

**Node revenue is a volume business.** At 150 CKB per switch per year, a launch-phase node is a contribution to the network, not income. This must be said to prospective operators up front, in these words, not discovered by them in month four.

Claim **batching** — one transaction per node per quarter across all its switches — is a v0.1 requirement, not an optimisation. Without it, per-claim network fees eat the fee.

### 11.5 The organiser fee is bypassable

By design. A user who builds their own transaction pays no organiser fee, and nodes still serve the switch because a node only checks that the Job Cell is funded. If there is no service, there is no fee.

The implication is [§8.5](#85-standalone-operation): the client must work standalone.

### 11.6 Registry pool

The 20% surcharge funds a separate public pool for watchtower bounties, liveness monitoring, reference hosting and audits.

In v0.1 it is controlled by the founding operator under a published policy. **This is a centralisation point and is labelled as one.** The intended path is an operator multisig; the transition is [open question O-6](#13-open-questions).

---

## 12. Relation to drand and to Sarcophagus

### 12.1 drand and tlock

| | drand / tlock | CRT |
|---|---|---|
| Membership | Fixed federation (League of Entropy) | Permissionless, staked |
| Key material | One long-lived threshold BLS group share | Fresh secp256k1 keypair **per switch** |
| Release value | Beacon signature over a round number | The per-condition private key |
| Condition | Round number = wall-clock schedule | CKB predicate: cell exists **and** chain time passed |
| Cancellation | Impossible | The primitive |
| Blast radius of a threshold collusion | Every ciphertext ever produced, retroactively | One switch |
| Cost per item | Zero | ~1,500 CKB per switch-year at 8 nodes |
| Latency, dependencies | None; no chain, no wallet | CKB RPC, a wallet, a funded escrow |
| Operating history | Years, in production | None |

**Why drand cannot simply add revocation.** The beacon signs round numbers on a single global schedule, and every ciphertext targeting round *N* depends on the same signature. Cancelling one item would mean withholding a value the entire world is waiting for. Revocation requires per-item key custody — precisely the cost drand refuses in order to scale to a free public beacon. Add to that the long-lived group share, which cannot be deleted and therefore makes "unrecoverable forever" unstateable.

**Where drand is better and should be used instead:** free, instant, no wallet, no chain, no dependency on a paid node business staying solvent, and a real track record. If your use case is a sealed bid, a commit-reveal, or a scheduled disclosure you will never want to stop, use tlock and ignore this repository.

### 12.2 Sarcophagus

Sarcophagus was an Ethereum + Arweave decentralised dead man's switch. Bonded operators — "archaeologists" — held key shards for an "embalmer", were paid to hold them, were slashed for failing to release, and released at a resurrection time unless the owner pushed it back. The node economics were close to identical to [§11](#11-economics). The project has since wound down. <!-- TODO: link the wind-down announcement before publishing; verify current status -->

That prior art is the most important input to this design, and the lessons are not cryptographic:

- **Demand was the binding constraint.** The protocol worked. Not enough people paid for a decentralised dead man's switch to sustain the operator set. No amount of better secret sharing fixes that, and CRT should not pretend otherwise.
- **Operator economics were thin.** Same risk here, quantified in [§11.4](#114-reference-pricing) rather than glossed.
- **Coupling to a storage layer added cost and lock-in.** Sarcophagus carried the payload to Arweave. CRT's [§1.2](#12-out-of-scope) refusal to touch user data is a direct response.
- **The product was an application, not a primitive.** An inheritance product has one narrow market. A revocable timelock has several, of which inheritance is one.

**What CRT changes deliberately:** cancellation is the first-class operation rather than a side effect of a missed renewal; keys are per-condition and CSPRNG-fresh rather than long-lived or derived; the coordinator cannot initiate any transaction and therefore cannot hold a switch hostage; the condition is anchored in a cell the *user* locks; and the fee path is bypassable, so the network survives the organiser.

**What is still unsolved:** demand, and operator economics. Both are business problems and neither is answered in this document.

---

## 13. Open questions

| Id | Question |
|---|---|
| O-1 | Threshold behaviour at small `n` — what is the minimum viable node set at launch? |
| O-2 | CKB price volatility over a multi-year escrow: fixed CKB, pegged, or top-up? |
| O-3 | Notice period length for node exit ([§9.4](#94-node-exit)) |
| O-4 | Rewrap when the owner is already dead — an executor who can rewrap but not release |
| O-5 | Should a node tell a stranger which `I` it serves? Privacy versus auditability |
| O-6 | Registry pool governance transition to an operator multisig ([§11.6](#116-registry-pool)) |
| O-7 | Domain-separator prefix: keep `TMN/v1` or move to `CRT/v1` before freezing scripts |
| O-8 | `GRACE` constant value ([§4.3](#43-predicate)) |

Argue with these in Discussions, not in issues.

---

## 14. Changelog

- `v0.1-draft` — first public form. Adapted from the private *TimeMachine Network* design note v0.3.
