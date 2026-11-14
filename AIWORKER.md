# Working on this repository as an AI worker

> **Note (2026-11-15).** The work is run by **AIWorker** on `pswsl` (see `aiworker/README.md`). The ready-to-upload specs
> are in `aiworker/specs/`; they point back to this file and to `aiworker/0N-*.md` for the details. Where this file
> talks about branches, commits, pull requests, a spec 00 or a `../` checkout, the rules in each spec's "How this
> project runs" section win. CSR spec 00 (`random_bytes`) shipped in CSR 0.6.1 and is no longer part of this plan.


This file is the contract between the maintainer and an autonomous coding agent ("the worker"). It follows the
convention used in `ckb-service-runner` (branches `aiworker/<name>`, protected `acceptance/aiworker-<name>/`
directories, `DECISIONS.md`). Read it fully before touching anything.

## 1. What to build, in which order

The work is cut into **specs** under `aiworker/`, numbered in dependency order. Each spec has **phases**. Run them
in order; a phase is done only when its acceptance tests pass (§4).

| Spec | Repository it runs in | Produces |
|---|---|---|
| `aiworker/00-csr-random-bytes.md` | `ckb-service-runner` (checkout at `.refs/csr`) | host call 7050 |
| `aiworker/01-crt-contracts.md` | this one | `contracts/crt-core`, `contracts/crt-node-lock` |
| `aiworker/02-crt-service.md` | this one | `service/crt-service`, `scripts/crt-enable.sh` |
| `aiworker/03-crt-client.md` | this one | `client/` (TypeScript library) |
| `aiworker/04-crt-web.md` | this one | `web/` (reference UI) + `site/` integration |
| `aiworker/05-crt-devnet-e2e.md` | this one + CSR | `scripts/devnet-e2e.sh`, measured cycle budgets, testnet deployment files |

`SPEC.md` is normative. When a spec file and `SPEC.md` disagree, `SPEC.md` wins and the worker notes the
disagreement in `DECISIONS.md`. When `SPEC.md` is silent, the worker decides, implements, and records the
decision (§5). The worker never waits for a human.

## 2. Environment

* Linux x86_64. Rust stable (≥ 1.80) with `rustup target add riscv64imac-unknown-none-elf`; `clang` ≥ 16 for the
  C stdlib of `ckb-std`; `moleculec` 0.9.x if schemas change (none are planned). `cargo` must be on `PATH` for
  the acceptance scripts (`~/.cargo/bin`; symlink into `~/.local/bin` if the judge's PATH lacks it, as noted in
  CSR `docs/decisions.md`, csr-service-catalog Phase 1).
* Node.js ≥ 22 (`node --test`), npm. No global npm packages.
* A checkout of `ckb-service-runner` at `.refs/csr` (tag ≥ 0.6.0, plus the result of spec 00 when a
  later spec needs it). Its `sdk/js/csr-job.mjs`, `scripts/devnet.sh`, `csr-dev` and `spec/*.md` are used
  read-only; this repository never vendors CSR code except the single file `client/vendor/csr-job.mjs` (copied,
  with its tag in a comment).
* Network: crates.io, npm, GitHub. Nothing else is needed. No testnet CKB is needed before spec 05 phase 3.

## 3. Rules

1. **No manual steps.** If a step truly needs a human (a signing key, funding a testnet address, DNS), the
   worker finishes everything around it, writes the exact commands into `docs/manual-steps.md`, and continues.
   `docs/manual-steps.md` is the last file of the project and the only place where a human is asked to do
   something.
2. **Protected paths** — never created, changed, moved or deleted by the worker: `acceptance/**`, `SPEC.md`,
   `AIWORKER.md`, `aiworker/**`, `spec/vectors/**`, `LICENSE`. If an acceptance test looks wrong, the worker
   implements what the test expects when that is consistent with `SPEC.md`, otherwise records the conflict in
   `DECISIONS.md` and moves on; it never edits the test.
3. **Branch and PR.** One branch per spec: `aiworker/<spec-name>` (e.g. `aiworker/crt-contracts`), from `main`.
   Commits `type(scope): summary`. One PR per spec against `main`, body from `.github/pull_request_template.md`,
   listing the phases done and the acceptance command. Security-sensitive changes (anything under `contracts/`
   or `service/`) tick the box.
4. **Quality gates** before a phase is called done: `cargo fmt --check`, `cargo clippy --all-targets -- -D
   warnings`, `cargo test` in every touched Rust workspace; `npm test` in `client/` and `web/`; the spec's
   acceptance command. All green, no skipped tests except those the spec marks as devnet-only.
5. **Documentation moves with the code.** Every phase updates the documents its spec names (`README.md`, `docs/`,
   `CHANGELOG.md`). Plain prose, no marketing. Numbers stated once, referenced elsewhere.
6. **No new dependencies without a line in `DECISIONS.md`** naming the crate/package, its version and why.
   Preferred: `ckb-std` 1.1.0, `k256` (no_std, `arithmetic` + `ecdsa` features off unless needed),
   `ckb-testtool`, `@noble/secp256k1`, `@noble/hashes`, `@ckb-ccc/core`, `vitest` or `node:test`, `vite`.
7. **Idempotent scripts.** Every script in `scripts/` can be re-run; it stops at the first failure
   (`set -euo pipefail`).
8. **Secrets.** Nothing secret enters the repository: no private keys, no funded testnet keys, no tokens. Devnet
   keys generated by scripts live under `.devnet/` (git-ignored).
9. **Determinism.** The recovery kit must be byte-for-byte reproducible from its inputs; tests check it.
10. **Zone.Identifier and archives.** The first phase of spec 01 removes the Windows `*:Zone.Identifier` files and
    `crt-spec-repo.tar.gz` and moves the v0.1-draft documents to `docs/history/` as `SPEC.md` §16 says.

## 4. Acceptance

Each spec names its acceptance directory `acceptance/aiworker-<name>/`. It contains:

* `wiring.test.mjs` — Node tests that check the presence and content of files (`node --test`);
* `named.mjs` — a script that runs named Rust or TypeScript tests and exits non-zero on failure;
* possibly `*.rs` test modules that the worker **includes** from the crate under test (never copies or edits).

A sibling shim `acceptance/aiworker-<name>.js` makes `node --test acceptance/aiworker-<name>/` work on Node 22
(it imports every `*.test.mjs`); run `node acceptance/aiworker-<name>/named.mjs` separately. The judge runs both
from the repository root with the default PATH.

## 5. `DECISIONS.md`

The root `DECISIONS.md` is the worker's log, newest spec first, one `##` section per spec and one bullet per
decision: what was unspecified or contradictory, what was chosen, why, and what a maintainer might want to
revisit. Short. It is the first thing the maintainer reads after a run. Decisions that change the protocol are
**also** proposed as a diff to `SPEC.md` in the PR description (the worker cannot edit `SPEC.md`).

## 6. When a phase cannot be completed

Record the blocker in `DECISIONS.md` with the exact error, finish every other deliverable of the phase, keep the
acceptance test failing (never fake a pass), and continue with the next phase if it does not depend on the
blocked one. A retry run reads `DECISIONS.md` first.
