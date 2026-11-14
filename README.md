# ckb-revocable-timelock (CRT)

**Timelock encryption with a working cancel button, built on [CKB Service Runner (CSR)](https://github.com/ckb-service-runner/ckb-service-runner).**

**Status: specification v0.2 complete, implementation in progress through the AI worker specs in `aiworker/`.
Testnet first.** Website: [crt.chainsolution.net](https://crt.chainsolution.net).

CRT lets anyone encrypt data to a future moment. A set of independent CSR runners each generate one fresh
secp256k1 private key for that single switch and publish it on chain only once a condition anchored on Nervos
CKB holds. Until then nobody — not the website, not any sub-threshold set of runners — can decrypt. If the owner
consumes the on-chain cell that anchors the condition, the condition becomes permanently unsatisfiable and every
runner's host deletes the key, so the data is unrecoverable forever.

CRT hands out a public key now and a private key later. Nothing else: it never sees, stores or moves user data.
Applications do that — the reference application is [dead-man-switch](https://github.com/psawyerberlin/dead-man-switch).

## How it works, in one screen

```text
owner wallet ──Create──►  Alive Cell (type-id T)   ·   n Node Cells   ·   n keygen jobs   ·   n heartbeat jobs
                                                             │                 │
CSR runner i (CRT service enabled) ──runs job──► fresh key d_i from the host CSPRNG, stored encrypted,
                                                 delete-on-consume bound to the Alive Cell,
                                                 pubkey P_i written into Node Cell i          (commit)
owner wallet ──Arm──►     descriptor_hash into every Node Cell; recovery kit downloaded
application  ──encrypt──► K split (Shamir / XOR) → one share wrapped to each P_i, stored with the ciphertext

every HEARTBEAT blocks: runner i runs its heartbeat job (paid a tip), checks the predicate, does nothing …
… until median_time ≥ deadline + 24 h and the Alive Cell is live:
                           Node Cell i → state released, **d_i in the cell data** (lock verifies pubkey(d_i) = P_i,
                           since ≥ deadline + 24 h, Alive Cell as dep)
anyone with the kit  ──►   reads the released d_i from the chain, unwraps t shares, recovers K

owner wallet ──Cancel──►  consume the Alive Cell with no replacement → condition can never hold;
                           CSR deletes d_i on every runner, even where the service is disabled
```

Three parties: the owner's wallet (signs every switch transaction), CSR runners (registered, staked, ranked;
they only run their own CSR jobs) and an optional, fully bypassable coordinator (v0.2). Everything a client
needs is public chain state; release values are in the chain forever.

The complete protocol is **[SPEC.md](SPEC.md)**. Why the design moved from its own node network to CSR, and
what that changed, is in SPEC.md §1.2 and §16.

## Repository layout

| Path | Contents | Status |
|---|---|---|
| `SPEC.md` | the protocol (normative) | v0.2 |
| `spec/vectors/` | conformance vectors shared by the Rust and TypeScript test suites | done |
| `aiworker/`, `AIWORKER.md` | build specs for the AI worker, phase by phase | done |
| `acceptance/` | acceptance tests per spec (protected) | done |
| `contracts/` | `crt-core` (shared `no_std` library) and `crt-node-lock` (the one CKB script) | spec 01 |
| `service/` | the CRT service that runs inside CSR | spec 02 |
| `client/` | TypeScript library: access trees, envelopes, descriptor, kit, transaction builders, recovery | spec 03 |
| `web/` → `site/app/` | reference web client | spec 04 |
| `site/` | the explainer website (deploy root of crt.chainsolution.net) | done |
| `scripts/` | build, operator enable/disable, devnet end-to-end, testnet deployment | specs 02, 05 |
| `deployments/` | per-network code hashes and the public CRT runner list | spec 05 |
| `coordinator/` | optional directory / mirror / unsigned-tx service | v0.2 |
| `docs/` | operators, developers, contracts, service, testing, history | partly |

## For whom

* **Run a CSR node?** Enable CRT with one script and earn tips per switch: [`docs/operators.md`](docs/operators.md).
  A launch-phase runner earns ≈ 183 CKB per switch-year; it is a contribution, not income.
* **Build an application** that needs a cancellable timelock (inheritance, escrow, dead drops, delayed
  disclosure): [`docs/developers.md`](docs/developers.md).
* **Review the protocol:** [SPEC.md](SPEC.md), then [CONTRIBUTING.md](CONTRIBUTING.md).

## Relation to drand/tlock and to Sarcophagus

drand/tlock is free, instant and chainless, and the right tool for most timelock use cases; it cannot add
cancellation because one beacon value serves every ciphertext and the group share can never be deleted.
Sarcophagus had CRT's economics (bonded operators holding shards, paid to hold, releasing at a resurrection time)
and died of thin demand and thin operator revenue, not of its cryptography. CRT keeps revocation as the
primitive, per-switch CSPRNG keys, a coordinator that can never sign, and no storage layer; it inherits its
operator network from CSR instead of building one. The demand question stays open. The longer comparison is in
[`docs/history/concept-v0.3.md`](docs/history/concept-v0.3.md) §15.

## Licence

MIT.
