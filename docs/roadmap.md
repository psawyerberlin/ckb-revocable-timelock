# Roadmap (proposals, not commitments)

## R-1. Sealed-to-runners mode: nobody holds a switch key, not even the creator

**Why.** Today the creating application generates a secret K, splits it (Shamir / XOR) and wraps one share to each
runner's public key `P_i`. The owner can read K again (the kit, `E(K)`, rewrap on renew). That is right for a
dead-man-switch, but an application such as VoteSecure must not trust the creator either.

**Idea.** The runners already create their own keys `d_i` and publish only `P_i` (Node Cell state 1). In this mode the
creator never generates a switch key. The switch publishes its descriptor (the runner public keys and the access
tree). Each item (a ballot, a message) is encrypted by whoever produces it: the encryptor makes a fresh per-item key,
splits it by the tree and wraps the shares to the `P_i`. Only the runners' keys `d_i`, released on chain after
the deadline plus grace, open the items. Before release nobody can read them: the creator, the website and the
application included.

**Work items.**
1. `client`: a descriptor-only create path (no K, no `E(K)`, no owner wrap) and `encryptTo(descriptor, data)` for one item;
   the recovery kit then holds the descriptor and the release procedure but no secret.
2. `web`: an option "Sealed to runners" on the Create flow; the kit and recovery pages say plainly that the owner has no key.
3. Tests: a created switch in this mode never stores or derives a K; an item encrypted to it opens only after the
   release on devnet.
4. No-cancel owner lock: the creator can still cancel and so destroy the runners' keys (a denial of service for a
   vote). The Alive Cell's lock decides who can cancel, so an application can set it to a multi-signature or a
   lock nobody can spend. The client needs to accept such an owner lock and the UI must warn that cancel is then impossible.

**What it does not remove.** A coalition of `t` runners can still decrypt early (diversity of runners matters), and an
item is only as private as its encryptor keeps the per-item key. With one testnet runner this mode can be built and
tested, but gives no protection until independent runners exist.

## R-2. One CRT service on CSR instead of two

**Why.** Testnet runs two CRT services next to each other: the standard one (`deployments/testnet.json`, GRACE 24 h)
and the rehearsal one (`deployments/testnet-drill.json`, GRACE 10 min, used for short fire drills). They have different
code hashes, so each runner publishes and enables two manifests, and every app has to pick the right deployment.
Operators should have to enable one service only.

**Idea.** Make the grace period a per-switch value that the contract reads, instead of a build-time constant, so the
same code and the same service ID serve both. Candidate design: the value is stored with the switch's parameters and
the node lock checks `since >= deadline + grace`. The 24 h minimum is kept for real switches by the client (and by
runners refusing a switch on mainnet with a smaller grace); drill-sized values are accepted on testnet and devnet only.

**Open questions.** Where the grace value lives (Alive Cell data or Node Cell data; the Node Cell format is frozen at
139 bytes, so this is a format change and needs a new version); whether the contract or the service can tell the
network (today only the client knows `network_id`); and how existing switches and manifests migrate.

## Open items (not design work)

- Testnet cancel check: `recover --name cancel`, expect `PASS: cancelled switch has no release` (runner key deleted at the next heartbeat).
- Testnet release check: `recover --name release` on Tue 17 Nov 2026, after deadline + 24 h (about 17:18 to 20:30 Berlin), expect the recovered K to equal the wrapped K.
- Add `wss://testnet.ckb.dev` and `wss://mainnet.ckb.dev` to the CSP header in the Caddyfile on the VPS (documented in `site/DEPLOY.md`).
- FAQ and privacy text: state that the owner can keep K and so is not bound by the lock (and that cancel does not destroy a copy of K).
- After both testnet checks pass: record the results in `docs/testing.md` and `DECISIONS.md`, mark phase 4 passed, make the repository public.
- dead-man-switch: run the AI worker specs `dms-core`, then `dms-ui`, then `dms-e2e`. Prerequisites: both testnet checks passed, the CRT repository public, a deploy key, the organiser address in `config/*.json`.
