# CKB Revocable Timelock (CRT)

## A Decentralised Conditional-Release Key Service on Nervos CKB

### Version 0.3 Concept

---

# 1. What This Is

CRT is public infrastructure, independent of any application built on top of it. It provides one primitive:

> Obtain a **recipient descriptor** today. Anyone can encrypt to it. Nobody can decrypt until a **condition** is satisfied on the CKB blockchain. If the condition is destroyed, the data is unrecoverable forever.

**In scope:** generating recipient descriptors, custody of the per-condition private keys, watching conditions on-chain, deleting keys on cancellation, publishing release values when conditions fire, node registry and reputation, fee escrow and settlement.

**Out of scope:** encryption and decryption of user data, storage of ciphertext, storage of plaintext, recipient management, email delivery. CRT never sees user data in any form. Applications do all of that.

DeadManSwitch is the first consumer of this service, not part of it. Other consumers could include escrow, journalist safe-deposit, sealed-bid auctions and delayed disclosure.

CRT is a **drand alternative** for conditional release: permissionless (anyone may run a node), paid (nodes earn fees, so operation is self-sustaining), and conditional (the trigger is on-chain state, not only a clock). Unlike drand, CRT requires per-secret setup, because per-secret setup is what makes per-secret payment and true key deletion possible.

---

# 2. Terminology

Precision here prevents a whole class of misunderstanding. These words are used consistently throughout.

| Term | Meaning | Not to be called |
|---|---|---|
| **Alive Cell** | CKB live cell with a unique type-id `T`, locked by the **user's** wallet, whose data holds the deadline. Its existence is the condition. | — |
| **Condition** | Predicate over CKB state: the Alive Cell exists and its deadline has passed. | — |
| **Per-condition keypair** | secp256k1 keypair a node generates **randomly**, for **one** switch only. Private half stored locally, deleted on cancellation. | "multisig key", "key share" |
| **Release value** | The per-condition **private key**, published by the node once the condition holds. | "the user's private key" |
| **Recipient descriptor** | See §2.1. The public document an application encrypts against. | "the public key" (singular) |
| **Recovery kit** | Downloadable, self-contained file given to the user at creation, holding the descriptor and everything needed to recover without CRT. See §6. | "the backup" |
| **Key envelope** | The wrapped key blobs produced by the **application** at encryption time. Not part of CRT. Must never be separated from its ciphertext. | "the descriptor" |
| **Access tree** | Client-side composition of XOR and Shamir splits expressing the required node structure. | "multisig" |
| **Identity key** | A node's long-lived registered key. Signs attestations, is slashed on misbehaviour. Never used to encrypt anything. | — |
| **Job Cell** | On-chain escrow holding fees for one switch. Nodes read it directly. | "payment to the platform" |
| **Coordinator** | Web interface and API, run by the **organiser**. Indexes the chain, mirrors descriptors, maintains the node directory. **Never signs or submits a CKB transaction** — read-only. Holds no keys, no user data, no custody. | "the platform", "the server that decrypts" |

**"Multisig" is never correct for this system.** No node signs a transaction on a user's behalf. The mechanism is threshold secret sharing plus public-key encryption.

## 2.1 Recipient descriptor — definition

A signed JSON document, typically 2–6 KB, produced by the client at creation. It contains:

```text
RecipientDescriptor {
  version           // format version
  network_id        // CKB mainnet / testnet
  type_id T         // the switch's permanent identity
  identity I        // derived, = blake2b256("CRT/v1/cell" || network_id || T)
  created_at        // ISO timestamp
  coordinator_url   // instance used at creation (informational only)
  access_tree       // XOR / Shamir structure, thresholds, branch labels
  nodes[] {
    node_id                 // registry cell identifier
    per_condition_pubkey    // secp256k1, compressed
    signature               // over (T, pubkey), by the node's identity key
    tree_position           // which branch and share index this key serves
  }
  share_commitments[]       // hash commitment per Shamir share
  descriptor_hash           // blake2b256 of the canonical form
}
```

**Everything in it is public, non-secret data.** It is the equivalent of an age recipient or a PGP public key: holding it lets you encrypt, never decrypt. It should therefore be stored redundantly rather than carefully.

**What it does not contain:** any private key, any ciphertext, and any key envelope. The wrapped blobs (`K_A` encrypted to the mandatory node, `share_i` encrypted to each threshold node) are produced by the **application** at encryption time and stored with the ciphertext. CRT never produces or holds them.

`descriptor_hash` is written into the Alive Cell as an integrity anchor. It lets a descriptor fetched from any untrusted source be verified, which is what makes wide redundant storage safe.

**The descriptor body is not stored on-chain.** Publishing the node list on-chain would hand a coalition a targeting map — in particular naming the mandatory node, which for a self-hosted node is a physical-address hint. The chain holds only the hash.

---

# 3. Design Decisions

## 3.1 No distributed key generation

An earlier draft used a DKG group with one group public key and threshold BLS. Rejected:

- It is a federation with open enrolment, not a permissionless network. Joining and leaving require resharing ceremonies.
- A single successful collusion reconstructs the group secret **once**, silently compromising every ciphertext the network has ever produced or ever will — past and future — with no detectable artefact.
- It cannot delete anything. Nodes hold one long-lived share used for every switch; deleting it breaks all users at once.

Independent per-node keys mean a coalition must re-form against each switch's specific node set. Different switches choose different sets. There is no single catastrophic event.

**Cost accepted:** descriptors name specific nodes and therefore rot as operators disappear. §11 and §12 address this.

## 3.2 Per-condition keys, not long-lived keys

A node generates a **fresh random** keypair for every switch it serves.

This is what makes deletion real. Seizing or compromising a node a year after cancellation recovers nothing, because the key is gone rather than re-derivable.

**The key must be random.** Deriving it from a node master secret via HKDF makes it re-derivable and deletion becomes theatre.

**Honest limit:** deletion is unverifiable. A node can quietly retain a key. Per-condition keys protect against *later* compromise of an honest node; they do not protect against a node dishonest from the start. That is what the threshold is for.

## 3.3 Release by key disclosure, not signature

The release value is the per-condition private key itself, published in the clear.

This avoids an identity-based-encryption construction where release is a signature over the condition identity — a design in which any protocol that asks a node to sign attacker-chosen input risks tricking it into emitting the release value early. Here the release action is disclosure, and signatures made with the same key leak nothing about it. The attack surface does not exist.

Consequence: CRT uses **secp256k1 throughout**, matching CKB natively, so node signatures verify inside CKB scripts with no exotic cryptography.

## 3.4 The coordinator is never trusted

Every fact the coordinator serves is verifiable against CKB or against node signatures. The client hard-fails on any mismatch. Multiple independent coordinators can run; the reference deployment is one instance.

---

# 4. Conditions

## 4.1 The Alive Cell

A CKB live cell with:

- **type script:** the standard `type-id` script, args = 32-byte unique id `T`. CKB guarantees `T` is globally unique and, once consumed without recreation, **can never be recreated by anyone**.
- **lock script:** the **user's** wallet lock (JoyID, omnilock, secp256k1-blake160, multisig, anything). Never the coordinator's.
- **data:**

```text
AliveCellData {
  version:        u8
  deadline:       u64      // unix seconds, evaluated against chain time
  policy:         u8       // 0 = release-at-deadline
  descriptor_hash:[u8;32]  // integrity anchor for the descriptor
}
```

## 4.2 Condition identity

```text
I = blake2b256( "CRT/v1/cell" || network_id || T )
```

The deadline is deliberately **not** in the identity. Renewal changes the cell's data but not `T`, so the identity — and every descriptor and ciphertext bound to it — survives unlimited renewals.

## 4.3 The predicate

A node publishes its release value if and only if, at a block `B` with at least `C` confirmations (recommended 30):

```text
∃ live cell with type-id T
AND  cell.data.deadline + GRACE <= median_time(B)
```

`median_time(B)` is CKB's median-of-past-37-blocks timestamp. **Node wall clocks are never used.** The clock is chain state, which is what makes premature release objectively provable rather than a dispute about whose NTP drifted.

`GRACE` (recommended 24h) absorbs clock skew and reorg risk. It is a safety margin, not a second chance: users renew before `deadline`.

## 4.4 Cancellation

The owner consumes the Alive Cell and creates no replacement. Type-id uniqueness makes `T` permanently unrecreatable, so the predicate is unsatisfiable for all future time. Nodes observe the consumption and delete their per-condition private keys.

Two independent guarantees, either sufficient: the condition can never fire, and the keys are gone.

## 4.5 Custom lock scripts are free

Nodes evaluate **only** the existence of a live cell with type-id `T` and its data field. The lock script is none of their business.

So the Alive Cell may be locked by multisig, by an executor's key, by a time-locked script, or by a DAO. Executor approval and corporate custody fall out with no protocol changes, and every node still computes the same answer.

This is different from letting users supply arbitrary **predicate** scripts for nodes to execute. That breaks threshold recovery whenever two nodes disagree about the result, and disagreement is indistinguishable from a liveness fault. Predicates stay fixed.

---

# 5. Access Trees

## 5.1 Two primitives

**Shamir `t`-of-`n`** gives thresholds but cannot express "must include node X" — shares are interchangeable by construction.

**XOR split** gives AND: `K = K_A XOR K_B`, both halves required, neither leaks a bit alone.

Mandatory nodes come from composing them.

## 5.2 Worked example — 5-of-8 with 1 mandatory

Where M is mandatory and is **one of the eight**, the other four come from the remaining seven:

```text
K
├── K_A ──────► encrypted to M's per-condition pubkey        (1-of-1)
└── K_B ──┬──► Shamir 4-of-7 over N1..N7
            └── share_i encrypted to N_i's per-condition pubkey
```

If M is a **ninth** node on top of a 5-of-8, the second branch is Shamir 5-of-8 instead. The UI must disambiguate these; "5 of 8 with 1 mandatory" usually means the first.

**Recovery:** unwrap `K_A` from M's release value — if M never publishes, `K` is unrecoverable, full stop. Unwrap any 4 of 7 available `K_B` shares, interpolate, `K = K_A XOR K_B`.

Each share carries a hash commitment in the descriptor, so a node returning garbage is identified immediately instead of surfacing as a silent interpolation failure.

## 5.3 Other structures

- **Several mandatory, all required:** chain the XOR — `K = K_M1 XOR K_M2 XOR K_rest`.
- **`j`-of-`m` mandatory:** the mandatory branch is itself a Shamir split. "2 of my 3 own nodes plus 5 of the public 8." **Recommended default** — `j = m` on a small set makes one machine a permanent-loss point.
- **Weighting:** give a node several Shamir shares. Surface this in the UI as effective control, not node count.
- **OR branches:** wrap `K` twice independently. Convenient, and a reliable way to destroy your own security model — the effective threshold is always the weakest branch.

## 5.4 The structure is invisible to nodes

A node sees a keygen request for identity `I` against a funded Job Cell, returns a signed public key, and later publishes a release value. It never learns the threshold, the other members, or whether it is mandatory.

The access structure needs **no protocol support**. New structures ship without touching a single node.

## 5.5 The standing trade

Every mandatory node makes the secret harder to steal and easier to lose, one for one. Hence `2-of-3` over `1-of-1`, and mandatory-branch headroom reported as its own number (§12).

---

# 6. Recovery Kit and Descriptor Storage

## 6.1 Why this matters

The descriptor is not secret, but it is **necessary**. Without it, a recipient does not know which nodes to ask, what the tree was, or how to reassemble the key. Losing it is fatal in the same way losing the ciphertext is fatal.

The correct response to necessary-but-public data is redundancy, not secrecy. Three copies, none of them authoritative on their own, all verifiable against `descriptor_hash` in the Alive Cell.

## 6.2 The recovery kit

Delivered as a download the moment the switch is created. A **single self-contained HTML file** that is simultaneously a certificate, an archive and a working tool:

```text
CRT Recovery Kit — switch <short-T>
├── Certificate page       human-readable, printable
│     issue timestamp, deadline, network, coordinator URL used,
│     access tree drawn as a diagram, node list with operators,
│     descriptor_hash, Alive Cell outpoint
├── Instructions           plain-language recovery steps, written for
│                          an heir or executor with no prior context
├── descriptor.json        embedded, exportable
└── Offline recovery tool  embedded JS, zero network dependencies:
                           paste release values, reconstruct the key
```

Design requirements:

- **Opens from a USB stick in 2040 with no internet.** No CDN, no external fonts, no framework loaded at runtime.
- **Prints to paper legibly.** The certificate page is the part a person files in a drawer or hands to a lawyer, and paper is the storage medium most likely to survive twenty years unattended.
- **Reads as a document, not a dump.** Someone who has never heard of CRT must be able to understand what they are holding and what to do with it.
- **Self-verifying.** On open, it recomputes `descriptor_hash` from the embedded descriptor and displays a match or mismatch banner.

The user is told plainly, at download and in the kit itself: keep this with the encrypted data, and keep a second copy elsewhere.

## 6.3 Coordinator mirror

The coordinator keeps a copy in its database, retrievable by **wallet login** — the user signs a challenge with the wallet that owns the Alive Cell, and gets back their descriptors and kits.

This is a convenience mirror, explicitly non-authoritative:

- it holds only public data, so a breach discloses node lists, not secrets
- any instance's copy is verifiable against the on-chain hash, so a tampered mirror is detected, not trusted
- the coordinator may vanish; the kit does not depend on it

## 6.4 Last-resort reconstruction

If every copy is lost but `T` is known, the node set can be partially recovered by polling the registry: each node knows which `T` values it serves. The **tree structure cannot** be recovered this way, because §5.4 deliberately hides it from nodes. Simple structures can be brute-forced; complex ones cannot. This is a salvage path, never a plan.

## 6.5 Boundary with the application

The key envelope is the application's artefact and must be stored **in the same file as its ciphertext**, never as a separate object. If a user loses the ciphertext they are already lost, so co-locating the envelope adds no new failure mode — while separating them creates one.

---

# 7. Architecture

## 7.1 Components

**Coordinator** — web interface plus API, run by the **organiser**, backed by a database that is an index, a cache, a descriptor mirror and the node directory. Every fact in it is reconstructible from CKB or verifiable against an on-chain hash. Holds no keys, no plaintext, no ciphertext, no custody of funds.

**The coordinator never initiates a blockchain transaction.** It only scans. It builds *unsigned* transactions as a convenience; the user's wallet signs and submits them. It holds no CKB except the service fees paid to its address as outputs of the user's own transactions. This means the coordinator has no on-chain operating cost, cannot be blocked by an empty wallet, and cannot act on a user's switch under any circumstances.

Who submits what:

| Transaction | Submitted by | Pays the CKB network fee |
|---|---|---|
| Create switch, renew, top up, cancel | **User's wallet** | User |
| Node registration, stake, exit notice | **Node** | Node |
| Fee claims (setup, quarterly, completion) | **Node** | Node, from its own revenue |
| Fraud proof | **Watcher** | Watcher, reimbursed from the slash |
| — | *coordinator: none, ever* | — |

**Nodes** — registered on CKB via a registry cell holding the long-lived identity public key, stake, endpoint and operator metadata. Each node runs a local encrypted database of per-condition private keys, one row per switch served.

**User wallet** — JoyID or any CKB wallet. Owns the Alive Cell, funds the Job Cell, authorises renewal and cancellation, and authenticates to the descriptor mirror.

## 7.2 Trust boundaries — what the coordinator cannot do

| Attack | Why it fails |
|---|---|
| Cancel or hold hostage a user's switch | The Alive Cell is locked by the **user's** wallet, and the coordinator submits nothing. It builds unsigned transactions; the user signs and broadcasts. |
| Substitute its own keys for node keys | Every per-condition public key is signed by the node's registry identity key. The client verifies against the on-chain registry and hard-fails. **Non-optional, no skip flag.** |
| Tamper with a mirrored descriptor | `descriptor_hash` is in the Alive Cell. Any client recomputes and rejects. |
| Defund nodes silently | Fees sit in the on-chain Job Cell. Nodes read the chain, not an invoice. |
| Gatekeep release | Nodes **publish** release values to their own endpoints and by gossip. The coordinator aggregates as a convenience; recipients can bypass it entirely. |
| Fake the node list or reputation | Registry entries are on-chain cells. Scores are advisory, derived from signed watchtower attestations anyone can recompute. |
| Read plaintext | It never receives any. Encryption is out of scope. |

---

# 8. Flow

**1. Configure.** User sets deadline, threshold structure (`t`-of-`n`, optionally naming specific nodes) and any mandatory branch. The client builds the access tree locally.

**2. Quote.** Fee computed per §9. The coordinator returns an **unsigned transaction** for the user's wallet to sign and broadcast — never an address to send funds to.

**3. Create on-chain.** The **user's wallet** signs and submits **one** transaction with three outputs:
- **Alive Cell** — type-id `T`, deadline, `descriptor_hash` (written in step 5). Locked by the user.
- **Job Cell** — escrowed node fees and registry pool, `funded_until`, per-node rate, merkle root of the node public keys.
- **Organiser service fee** — a plain output to the organiser's CKB address.

All CKB originates from the user. The coordinator detects the transaction by scanning.

**4. Key generation.** The **client** requests a per-condition keypair from each selected node, passing `T`. Each node independently verifies the Job Cell is funded on-chain, generates a random secp256k1 keypair, stores the private half, and returns the public half signed by its registry identity key. The client verifies every signature against the on-chain registry.

**5. Descriptor and kit.** The client assembles the descriptor, writes `descriptor_hash` into the Alive Cell, generates the recovery kit, downloads it to the user, and mirrors a copy to the coordinator.

**6. Encryption.** Out of scope. The reference interface offers a purely client-side convenience page; plaintext never leaves the browser.

**7. Monitoring.** Per-switch status: alive or consumed, deadline, funded-until, live nodes versus threshold, and **mandatory-branch headroom as a separate figure**.

**8. Renewal and top-up.** The user signs and submits a transaction updating the deadline or adding capacity to the Job Cell. Their wallet, their signature, their broadcast, every time.

**9. Node duty cycle.** Nodes submit their own transactions for registration and for every fee claim, paying their own network fees. Nodes poll CKB. Cell consumed without replacement → delete the private key immediately and permanently. Deadline passed with cell alive → publish the release value, claim the completion payment, then delete the key.

**10. Recovery.** Anyone holding the kit collects published release values, unwraps enough branches to satisfy the tree, and reconstructs the decryption key. No account, no permission, no coordinator.

Every step above is available over the API. That is the product; the web interface is a reference client.

---

# 9. Economics

## 9.1 Why fees are escrowed at setup

A dead user cannot be invoiced. The full amount is locked in the Job Cell on day one. The design question is not when the user pays but **when a node may claim**.

## 9.2 Why not pay only at the end

Pay-on-completion alone inverts into the failure it is meant to prevent:

- **Nothing verifies the key still exists.** A node earning nothing for years is rationally incentivised to prune cold keys and collect on near-term switches. Nobody discovers this until a recovery fails.
- **Cash flow excludes newcomers.** Years of zero revenue admits only operators who can self-fund, concentrating the set. Concentration is the one thing a threshold assumption cannot survive.
- **It rewards the release event.** Custodians of "this must not open early" should not hold a position that pays out on opening.

## 9.3 Node fee claim schedule

Each node's fee for a switch is claimed in three parts:

| Part | Share | When claimable |
|---|---|---|
| **Setup** | 10% | On returning a valid signed per-condition public key |
| **Retainer** | 80% | Vesting quarterly across the term, claimed every 3 months |
| **Completion** | 10% | On publishing the release value, or on cancellation |

**Setup** pays for keygen and the storage commitment, and makes serving a switch immediately worthwhile at any term length.

**Retainer** is the bulk, and it is the part that keeps nodes alive. It vests on the calendar regardless of user activity — a dormant switch still pays its custodians.

**Completion** is claimable on release only by a node that actually **published** its release value; the claim script verifies the disclosed private key against the public key committed in the Job Cell's merkle root. Publishing early cannot accelerate payment, because the script will not pay before the deadline, and early publication is separately slashable. On **cancellation** the completion share is released to the serving nodes — a node that earned nothing for a cancelled switch would have no reason to ever delete anything.

**Terms shorter than one quarter:** the retainer vests as a single payment at resolution. No pro-rata micro-claims.

## 9.4 Proof of possession

Timed vesting alone would pay a node that deleted the key. Each quarterly claim is gated on a **proof of possession**: the node signs a challenge with the per-condition private key itself.

```text
challenge = blake2b256( "CRT/v1/pop" || T || block_hash(H) )
```

Chain-derived and unpredictable, so a node cannot precompute years of proofs and then delete. The claim transaction carries the signature plus a merkle proof of the node's public key against the Job Cell root; the script verifies with CKB's native secp256k1.

Because release is key *disclosure* and not a signature, signing this challenge leaks nothing about the key.

## 9.5 What this achieves

Compare two nodes serving the same three-year switch.

**The honest node** claims setup at month 0, then a retainer instalment every quarter for twelve quarters, then completion at release. It collects 100%.

**The node that quietly deletes cold keys** to save storage claims setup, then one or two quarterly instalments — and then hits a quarter where it cannot produce a proof of possession, because the key is gone. It collects perhaps 25% and forfeits the rest.

The point is **when** the second node is caught. Not at release, years later, when the data is already lost and the operator has unbonded and vanished — but at the **next quarterly claim**, typically within three months of the defection, while the stake is still bonded and slashable and while the user still has time to rewrap onto healthy nodes.

That early detection is the entire reason the retainer exists. A pure completion payment would produce the same total for an honest node and would catch a cheat exactly once: too late.

## 9.6 Registry pool

A separate 20% surcharge, paid by the user on top of the node fee, into a **public maintenance pool** with its own on-chain lock. It is not a coordinator margin — the coordinator's own revenue is the per-transaction service fee in §9.7, which is charged separately and visibly.

The pool funds work that benefits every participant but that no single node has an incentive to do:

| Draw | Purpose |
|---|---|
| Watchtower bounties | Paid automatically to whoever submits a valid fraud proof, from the slashed stake plus a pool top-up |
| Liveness monitoring | Independent watchtowers running the challenge/response probes that produce reputation scores |
| Reference coordinator hosting | Keeping at least one free public instance and the registry site online |
| Protocol audits | Periodic external review of node and script code |

**Governance, stated honestly:** in v0.1 the pool is controlled by the founding operator under a published spending policy, because there is no one else yet. That is a centralisation point and should be labelled as such in the launch material rather than dressed up. The intended path is control by an n-of-m multisig of registered node operators once the registry is large enough for that to mean anything.

## 9.7 Fee table

Reference pricing at **CKB = $0.01** (100 CKB = $1.00).

### Who pays what

**All CKB for creating a switch comes from the user's wallet, in one transaction.** The organiser initiates nothing and therefore has no on-chain cost to recover — its fee is a service fee for the interface, the descriptor mirror and the node directory, paid as a plain output in the user's own transaction.

Nodes fund their own registration and their own claims from their own wallets.

### User: creating a switch

One transaction, three outputs plus change:

| Component | Amount | Nature |
|---|---|---|
| **Node fee** | 150 CKB per node per year | Escrowed in the Job Cell, claimed by nodes on the 10/80/10 schedule |
| **Registry pool** | +20% of the node fee | Escrowed in the Job Cell, claimed by the pool lock |
| **Organiser service fee** | 100 CKB ($1.00) | Output to the organiser's address, spent |
| **Alive Cell capacity** | ~150 CKB | Locked, **refunded** when the cell is consumed |
| **Job Cell overhead** | ~130 CKB | Locked, **refunded** when the cell is finally exhausted |
| **CKB network fee** | ~1 CKB | Spent |

Minimum term 3 months; minimum node fee 400 CKB per switch.

Note the Job Cell's capacity *is* the escrow — in CKB, capacity is the coin. The cell shrinks as nodes claim, and its overhead returns to the user at the end.

### User: later transactions

| Transaction | Organiser fee | Notes |
|---|---|---|
| Renew / extend deadline | 50 CKB ($0.50) | Usually paired with a Job Cell top-up |
| Top up Job Cell | 50 CKB ($0.50) | Extends `funded_until` |
| Cancel | **0 CKB** | Free on principle — see below |
| Rewrap onto a new node set | 100 CKB ($1.00) | Same work as a creation |

**Cancellation is free.** A fee on destruction is a fee on the user's primary safety mechanism, and friction there is a design defect, not a revenue opportunity.

### Node: costs and revenue

| Item | Amount | Nature |
|---|---|---|
| Registry cell capacity | ~200 CKB | Locked, refunded on graceful exit |
| Stake | 10,000 CKB ($100) | Locked, slashable |
| Registration network fee | ~1 CKB | Node pays |
| Claim network fee | ~1 CKB per batch | Node pays, batched across all switches due |
| **Revenue** | 150 CKB per switch per year | 15 setup, 30 per quarter, 15 completion |

### Worked examples

| Scenario | Node fee | Pool | Organiser | **Spent** | **Locked (refundable)** |
|---|---|---|---|---|---|
| 8 nodes, 1 year | 1,200 | 240 | 100 | **1,541 CKB ≈ $15.41** | 280 CKB |
| 5 nodes, 1 year | 750 | 150 | 100 | **1,001 CKB ≈ $10.01** | 280 CKB |
| 8 nodes, 6 months | 600 | 120 | 100 | **821 CKB ≈ $8.21** | 280 CKB |
| 8 nodes, 3 months (floor) | 400 | 80 | 100 | **581 CKB ≈ $5.81** | 280 CKB |
| 8 nodes, 10 years | 12,000 | 2,400 | 100 | **14,501 CKB ≈ $145** | 280 CKB |

### Two consequences worth stating plainly

**The organiser fee is bypassable, by design.** A user who builds the creation transaction themselves can omit the fee output entirely, and nodes will still serve the switch — they check only that the Job Cell is funded. This is correct for a permissionless protocol: the organiser is paid for the interface, the mirror and the directory, not for permission. It also means the organiser's revenue depends on being genuinely useful, which is the right pressure.

**Node economics are a volume business.** At 150 CKB per switch per year, an operator serving 10,000 switches earns roughly $15,000/year; one serving 100 earns $150. Operators must be told this plainly. A launch-phase node is a contribution, not income, and implying otherwise produces operators who quit — the failure this protocol absorbs worst.

**Claim batching is a v0.1 requirement, not an optimisation.** A node with 10,000 switches must not submit 10,000 quarterly claims. Claims aggregate into one transaction per node per quarter, carrying a batched proof across every switch due. Without it the network fees and the operational burden make a large node unviable.

## 9.8 Price volatility

Fees are quoted in CKB and escrowed in CKB. A ten-year switch funded at $0.01/CKB is exposed to the CKB price moving in either direction — nodes may find a long switch underpaid in real terms, or users may find they overpaid enormously. Options are a stablecoin-denominated rate with a CKB oracle, periodic re-quoting at renewal, or simply accepting the exposure with a published rate-review policy. **Unresolved** — see §18.

---

# 10. Node Rules

A conforming node MUST:

1. Follow CKB from a full node it operates or trusts. The coordinator is a directory, never an oracle.
2. Evaluate the predicate only against confirmed chain state at depth `C`, using `median_time` exclusively.
3. Generate per-condition keypairs from a **CSPRNG**, never derived from a master secret.
4. Never disclose, sell, transmit, export or log a per-condition private key before its predicate holds.
5. Publish the release value promptly once the predicate holds, then delete the key.
6. Delete the key immediately and irreversibly on observing cancellation.
7. Answer liveness challenges within the response window.
8. Keep per-condition keys encrypted at rest, hardware-backed where available, never on a host that also terminates public TLS.
9. Maintain a stake cell with a valid slashing lock.
10. Publish operator metadata: contact, jurisdiction, ASN, hosting provider. Diversity is the only real defence against a colluding majority, and it cannot be scored if it is not declared.
11. Give **on-chain notice before closing**, and keep serving through a mandatory notice period. Unbonding releases the stake only after it expires.
12. Batch quarterly claims into a single transaction.

A conforming node MUST NOT:

- generate keys for an unfunded Job Cell (this is also the anti-DoS control — keygen must cost money before it costs storage)
- accept condition parameters from an API rather than chain state
- sign anything outside the fixed PoP challenge template
- run more than one registry entry per physical host or key

---

# 11. Choosing a Duration and Structure

**The expected case is under one year.** Multi-year switches will be rare, and the two cases carry materially different risk. The interface must guide accordingly rather than presenting a blank date field.

## 11.1 Why duration dominates risk

Node closure is the principal threat to recoverability, and it compounds with time. A node set that is healthy today is very likely still healthy in six months, and a coin-flip at ten years. Descriptor rot (§12) is a function of elapsed time, not of anything the user chose about cryptography.

## 11.2 Guidance by term

| Term | Risk posture | Recommended structure |
|---|---|---|
| **Under 1 year** (expected case) | Low. Node churn over months is small and observable. | Threshold alone is fine. 5-of-8 with no mandatory node. Simple, no single point of loss. |
| **1–3 years** | Moderate. Expect to lose some operators. | Wider set, more headroom: 6-of-12. Add a mandatory branch only if the threat model needs it. |
| **3+ years** (rare) | High, and the risk is **loss**, not disclosure. | Wide set plus `2-of-3` mandatory on nodes the user controls, **plus** renewal-driven rewrap as standing policy. Never `1-of-1` mandatory. |

## 11.3 What the interface must do

- Show a **plain-language risk statement** at the chosen duration, not a number. "At ten years, expect roughly half these operators to be gone. Your recovery depends on rewrapping at each renewal."
- **Default to the threshold-only structure** for terms under a year. Mandatory nodes are a power-user feature that trades recoverability for control, and offering them by default would push novices toward the failure mode that actually happens.
- **Refuse to silently accept `1-of-1` mandatory on a multi-year term.** Require explicit acknowledgement that one machine's disk now holds the whole guarantee.
- Make **renewal cadence** a first-class choice, and state that renewal is when rot gets repaired.

The user carries this decision, and the client's job is to make sure they carry it knowingly.

---

# 12. Risk: Node Closure and Descriptor Rot

The principal long-term risk. A descriptor written today names specific nodes; if too many vanish, the data is permanently unrecoverable.

## 12.1 Detection

Two headroom figures per switch, both required:

```text
threshold headroom = live_in_set − t          (7 live, 4 needed → 3)
mandatory headroom = live_mandatory − j       (the one that kills you)
```

A `2-of-3` mandatory branch at headroom 0 is an emergency even when the main set shows 3 spare. The two degrade for unrelated reasons: threshold headroom erodes slowly and statistically; mandatory headroom collapses in a single event. `overall` status is the **minimum** across branches, never an average.

## 12.2 Notification

A monitoring page only helps someone who visits it; a long-dated switch needs push.

Storing user email addresses next to condition identities would make the coordinator a correlation target — precisely what this architecture otherwise avoids. So: **the coordinator publishes headroom as data with webhooks; applications notify their own users.** DeadManSwitch already holds the address and already sends renewal reminders, so node-health warnings ride along at zero marginal privacy cost. Direct email subscription is offered only for users with no application in front of them.

## 12.3 Repair

Rewrap. At renewal the client re-issues the descriptor against a currently-healthy node set, the application re-encrypts, and a new recovery kit is issued. A switch that is being renewed is being continuously healed.

This requires the owner to still reach `K`. The application stores `E(K)` under a wrapping key derived from the owner's wallet signature — unwrappable by the owner, nobody else. It adds one biometric prompt to a renewal the user is performing anyway.

---

# 13. Rogue Node Detection

**Liveness.** Independent watchtowers issue PoP challenges and record response latency. Requiring multiple independent watchtowers matters — a single coordinator able to unilaterally mark nodes offline would be a censorship vector.

**Premature disclosure — objective fraud proof.** A published per-condition private key verifies against the public key committed in the Job Cell. A watcher submits it with a cell dep proving the deadline has not passed; the script slashes the stake, part burned, part to the watcher. The node incriminates itself by the act of leaking, which is what makes bribery expensive rather than merely discouraged.

**Withholding.** Refusal to publish a due, funded release value cannot be proven by a single observer. It is attested by a quorum and costs the completion payment, not the stake.

**Sybil.** CRT claims Sybil *visibility*, not Sybil resistance. Stake raises the cost; declared metadata and diversity scoring let users price the risk; mandatory nodes let them route around it entirely.

## 13.1 The node directory

Maintained by the organiser, and one of the two things the service fee actually pays for. It is assembled by **scanning the chain** for registry cells and **probing** node endpoints — the organiser writes nothing on-chain to produce it.

Per node:

| Field | Source | Why it matters |
|---|---|---|
| Node id, operator name, endpoint | Registry cell | Identity |
| **Registered since** | Registry cell creation block | Age is the single best available predictor of whether a node will still be there in five years |
| Stake | Stake cell | What misbehaviour costs |
| Switches served, keys held | Node self-report, cross-checked against Job Cells | Load, and whether the operator is at scale or hobbyist |
| **Availability** — 30d / 90d / 365d | Watchtower PoP probes | Recent uptime, and the long window that catches seasonal neglect |
| Median and p95 response latency | Probes | Operational health |
| Missed proof-of-possession events | Claim history on-chain | The early-warning signal for key loss (§9.5) |
| Slash history | Slashing transactions | Objective misconduct, permanent record |
| Exit notice status | Registry cell | Whether this node is leaving |
| Jurisdiction, ASN, hosting provider | Operator declaration | Coalition diversity |
| **Rating** | Composite, formula published | One number for users who will not read the rest |

Directory rules:

- **Every field is independently recomputable.** Chain-derived fields come from CKB; probe-derived fields come from signed watchtower attestations that anyone can download and recheck. The directory is a convenience, never an authority.
- **The rating formula is published, versioned, and changes are announced.** An unpublished formula is a lever the organiser could sell.
- **Multiple watchtowers, or none.** A directory whose availability data comes solely from the organiser is a censorship vector — it could quietly bury a competitor's node.
- **New nodes are marked as unproven rather than penalised.** A rating that punishes youth freezes the set and defeats permissionless entry.

The directory also publishes **coalition risk** across the whole network: concentration by operator, hosting provider, ASN and country. If 71 of 100 nodes sit in one AWS region, the threshold is decorative — and that number belongs on the front page, not in an appendix.

---

# 14. Bootstrap Posture

At launch there will be few nodes and the threshold will be genuinely weak. Say so, and lead with the honest framing:

> **Run your own node and mark it mandatory. Then no coalition of every other operator can open your data.**

Early security comes primarily from a node the owner controls, with the network as defence in depth. As `n` grows, the two swap places.

The failure mode inverts accordingly: a self-run mandatory node is a single point of loss — but because the owner controls it, they can back up its per-condition keys, which they can do for no one else's node. **Backup and restore belongs in the node CLI from day one.**

---

# 15. Cryptographic Horizon

**Post-quantum security is out of scope for CRT v1.** The protocol uses secp256k1 throughout and makes no post-quantum claim.

This is a deliberate scope decision, not an oversight. It is defensible because the expected case is a deadline under one year (§11), which sits far inside any credible risk window. It becomes indefensible if users assume a multi-decade guarantee that was never offered.

**Required disclaimer, displayed in the web interface at the point of choosing a deadline** — not buried in terms of service — whenever the term exceeds five years:

> TimeMachine Network uses secp256k1 elliptic-curve cryptography, the same cryptography that secures Bitcoin and Nervos CKB. It is not quantum-resistant. A sufficiently capable quantum computer could recover keys protected by it. No such machine is known to exist, and expert estimates for when one might vary widely.
>
> For deadlines within a few years this is not a practical concern. For deadlines a decade or more away, you are accepting a risk that cannot currently be quantified. If your data must stay confidential that long, renew and rewrap periodically so it can be migrated to stronger cryptography when it becomes available.

Rewrap (§12.3) is the migration path, which is a further reason to make it a first-class operation rather than a repair mechanism.

---

# 16. API

```text
GET  /v1/nodes                    registry with scores, stake, metadata, diversity stats
GET  /v1/nodes/:id                detail, identity key, slash history, notice status
POST /v1/switches/quote           fee quote for a proposed structure
POST /v1/switches/tx              build UNSIGNED create / renew / cancel / topup tx
                                  (user's wallet signs and broadcasts; coordinator never submits)
GET  /v1/switches/:T              status, deadline, funding, both headroom figures
GET  /v1/switches/:T/descriptor   mirrored descriptor (verify against on-chain hash)
GET  /v1/switches/:T/kit          regenerate the recovery kit
GET  /v1/switches/:T/release      collected release values
POST /v1/switches/:T/release      relay a release value (gossip)
POST /v1/mine                     wallet-authenticated: this wallet's switches and kits
POST /v1/fraud                    relay a fraud proof
GET  /v1/health                   watchtower view, coalition risk summary
```

Node endpoints, called directly by clients:

```text
POST /keygen                      { T } → { pubkey, sig_by_identity_key }
GET  /release/:T                  release value, once due
POST /pop                         PoP challenge response
```

There is no encrypt or decrypt endpoint anywhere. Both are the application's job.

---

# 17. Repositories

| Repo | Language | Contents |
|---|---|---|
| `CRT-node` | TypeScript (v0.1), Rust (v1.0) | chain follower, predicate engine, keygen, key store, publication, batched claims, backup CLI |
| `CRT-scripts` | Rust / ckb-std | AliveCell type script, JobCell, RewardLock, RegistryCell, StakeCell, slashing |
| `CRT-client` | TypeScript | access-tree builder, descriptor assembly and verification, recovery-kit generator, tx builders, offline recovery |
| `CRT-api` | TypeScript | coordinator, indexer, watchtower, descriptor mirror, registry site |
| `CRT-spec` | Markdown | wire formats, identity derivation, kit format, conformance vectors |

TypeScript for the v0.1 node is a velocity choice; it shares crypto code with the client, so both test against the same vectors. A Rust rewrite belongs before significant value is at stake, and the spec plus conformance vectors make that a swap rather than a rebuild.

---

# 18. Open Questions

1. **Threshold at small `n`.** At `n = 8`, `t = 6` is a liveness bet. Does the mandatory-node story carry launch security entirely until `n` grows, and what is the published guidance?
2. **CKB price volatility** (§9.8). Fixed CKB rates, stablecoin denomination with an oracle, or re-quoting at renewal?
3. **Notice period length.** Long enough for users to rewrap, short enough that operators accept the stake lock-up.
4. **Rewrap without owner participation.** If the owner is already dead, rot cannot be repaired — precisely when the switch matters most. Should applications support a designated executor who can trigger rewrap but not release?
5. **Node privacy.** Should a node answer "do you serve `T`?" to an unauthenticated stranger? Refusing hardens against coalition targeting but breaks the §6.4 salvage path.
6. **Registry pool governance.** What size of registry justifies moving from founding-operator control to an operator multisig, and what is the mechanism for that transition?
