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
