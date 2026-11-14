# Contributing

The specification is at v0.2 (`SPEC.md`, CSR edition) and the implementation is being built spec by spec
(`aiworker/`). Both kinds of contribution are welcome; keep them apart.

## Where to put things

| You want to | Use |
|---|---|
| Argue with a design decision | **Discussions → Ideas**, citing the SPEC section number |
| Ask how something is meant to work | **Discussions → Q&A** |
| Report that the spec text is wrong, contradictory or unclear | **Issues** (label `spec`) |
| Report a bug in `contracts/`, `service/`, `client/`, `web/` | **Issues** (label of the component) |
| Say you run a CSR node and would enable CRT, and on what terms | **Discussions → Show and tell** |
| Add your runner to the public list | PR on `deployments/<network>-runners.json` |

## What is most useful now

1. Attacks on [SPEC §12](SPEC.md#12-threat-model) and on the lock script rules of [§4](SPEC.md#4-the-crt-node-lock-script):
   the `since` / median-time assumption and the Alive-Cell-as-dep rule carry the whole design.
2. A CSR maintainer's read of [§5](SPEC.md#5-the-crt-service-runs-inside-csr) and [§14](SPEC.md#14-csr-requirements).
3. Node operator reality checks on [§11](SPEC.md#11-economics).
4. Anyone who knows first-hand why Sarcophagus wound down (`docs/history/concept-v0.3.md` §15).

## House style

- Every SPEC section is numbered and stays numbered from v0.2 on. Renumbering breaks every citation ever made.
- Decisions carry their reason. "We use X" without "because Y" gets reopened every six months.
- Limitations go in the spec, not in a FAQ.
- Numbers are stated once (SPEC §11 for costs) and referenced elsewhere.
- Code: Rust `cargo fmt`, `cargo clippy -- -D warnings`, `cargo test`; TypeScript `npm test`. Commit messages
  `type(scope): summary`.

## Pull requests

- Spec changes: only after a discussion; a PR that changes a design decision without a linked discussion is
  closed with a pointer to this line.
- Code: one topic per PR, against `main`, template in `.github/`. Anything under `contracts/` or `service/` needs
  two reviews. The AI worker's PRs follow `AIWORKER.md` and are reviewed like any other.
- Never edit `acceptance/**` in a PR that also changes the code it tests.
