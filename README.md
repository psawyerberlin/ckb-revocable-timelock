# ckb-revocable-timelock (CRT)

**Status: specification draft `v0.1-draft`. No code yet. Comments wanted before anything is built.**

CRT lets anyone encrypt data to a future moment: a set of independent, permissionless nodes each generate one fresh secp256k1 private key for that single switch, and publish that key only once a condition anchored on the Nervos CKB chain is satisfied. Until then nobody — not the coordinator, not any sub-threshold set of nodes — can decrypt. If the owner consumes the on-chain cell that anchors the condition, the condition becomes permanently unsatisfiable and the nodes delete their keys, so the data is unrecoverable forever.

In one line: **timelock encryption with a working cancel button.**

The full protocol is in [SPEC.md](SPEC.md).

---

## Why this exists

Timelock encryption today is a one-way ratchet. You pick a future time, you encrypt, and the release will happen — there is no way to change your mind, because the release value is a global beacon that the rest of the world also depends on. That is fine for auction commitments and sealed bids. It is wrong for anything where "I am still here" is the actual message: inheritance, escrow, whistleblower dead drops, key escrow with an opt-out, delayed disclosure that a court order should be able to stop.

CRT makes cancellation a first-class operation, at the cost of per-switch key custody and a fee.

## Repository layout

| Path | Contents |
|---|---|
| `SPEC.md` | The protocol: conditions, key model, access trees, descriptors, economics |
| `node/` | Node operator contract — on-chain registration, HTTP API, key lifecycle |
| `coordinator/` | Coordinator contract — directory, descriptor assembly, release aggregation |
| `CONTRIBUTING.md` | How to comment on the spec |

`node/` and `coordinator/` contain no code yet. Their READMEs define the interface between them so that the two can be implemented independently, by different people, in different languages.

## Relation to drand and to Sarcophagus

Two projects have already been where this one is going. Neither is a competitor and one of them is dead; the honest comparison is below, and a longer technical version is in [SPEC.md §12](SPEC.md#12-relation-to-drand-and-to-sarcophagus).

### drand / tlock

[drand](https://drand.love) is a threshold BLS randomness beacon run by the League of Entropy, a fixed federation of known operators. `tlock` builds timelock encryption on top of it with identity-based encryption: you encrypt to round *N*, and when the beacon signs round *N* that signature is the decryption key. It is free, instant, needs no chain, and is the right tool for most timelock use cases. Use it unless you need what follows.

drand cannot add cancellation, and this is structural rather than a missing feature:

1. **One release value serves every ciphertext for a round.** To cancel one item you would have to withhold a beacon signature the whole world is waiting for. Per-item revocation requires per-item key custody, which is exactly the cost drand avoids in order to scale.
2. **The group share is long-lived and cannot be deleted.** A successful collusion of the threshold at any point in the future retroactively opens every ciphertext ever produced against that group. CRT generates a fresh keypair per switch and destroys it, so a compromise costs one switch, not the archive.
3. **Membership is a federation.** Joining is a social process. CRT's node set is permissionless and staked, so the security argument is "a few hundred independent operators with per-switch keys" rather than "a few dozen reputable ones with a shared one."

What drand does better: no fees, no chain, no wallet, no liveness dependency on a paid node business, and a real operating history. CRT is more expensive per item by orders of magnitude and will be much lower volume. That trade is only worth making when revocation matters.

### Sarcophagus

[Sarcophagus](https://app.sarcophagus.io/) was an Ethereum + Arweave decentralised dead man's switch, and the node economics were close to identical to what is proposed here: bonded operators ("archaeologists") held key shards, were paid to hold them, were slashed for failing to release, and released at a resurrection time unless the owner rewound the clock. Appears inactive as of 2024 (https://github.com/sarcophagus-org).

Taking that seriously means naming what killed it rather than assuming better cryptography fixes it:

- **Demand, not crypto, was the binding constraint.** The protocol worked. Not enough people wanted to pay for a decentralised dead man's switch to sustain the operator set.
- **Node revenue is thin.** At CRT's reference pricing, a node earns roughly 150 CKB per switch per year. A launch-phase node is a contribution to the network, not income, and the spec says so to operators up front rather than in a footnote.
- **Coupling to a storage layer added cost and lock-in.** Sarcophagus carried the payload. CRT does not store, encrypt, or ever see user data — it hands out a public key and later a private key, and the application keeps its own bytes wherever it likes.

What CRT changes on purpose: cancellation is the primitive rather than a side effect of missing a renewal; keys are per-condition and CSPRNG-fresh rather than derived; the coordinator can never initiate a transaction, so it cannot hold a switch hostage; and the product is a general timelock primitive, not an inheritance app. Inheritance becomes one consumer of it.

What has not been solved: the demand question is still open, and so is the operator economics. If this repository ends at a specification that saves the next person from rebuilding Sarcophagus, that is still a result.

## What would make this real

- Reviewers who will argue with [SPEC.md](SPEC.md), especially §3 (threat model) and §11 (economics).
- One CKB script author willing to sanity-check the Alive Cell / type-id assumptions in §4.
- Node operators willing to say what fee and what notice period they would actually accept.

Open a thread in **Discussions** — issues are for defects in the spec text, discussions are for the design.

## Licence

MIT — see [LICENSE](LICENSE).
