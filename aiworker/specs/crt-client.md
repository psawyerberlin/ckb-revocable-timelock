---
project: crt-client
default_model: sonnet
protected_paths: [acceptance/, SPEC.md, AIWORKER.md, aiworker/, spec/vectors/]
source:
  repo: git@github.com:psawyerberlin/ckb-revocable-timelock.git
  ref: main
  key: ckb-revocable-timelock
push:
  branch: aiworker/crt-client
  when: phase
---

# Concept
CRT (CKB Revocable Timelock) lets an owner lock a secret behind a deadline that any holder of a renewal can postpone or cancel, using CSR runners as custodians of per-switch keys. Stack: Rust (`no_std`, ckb-std 1.1, ckb-testtool 1.1, k256) for contracts and the CSR service, TypeScript (ESM, Node 22, `@noble/*`, `@ckb-ccc/core`, Vite) for the client and the web app.
## How this project runs (read first)

This repository already contains the full design: `SPEC.md` is **normative**, and the file named in each phase
under `aiworker/` holds the exact interfaces, file names, test names and deliverables of that phase. The
acceptance tests already exist under `acceptance/` and are protected: do not edit them, implement what they check.
`AIWORKER.md` describes the same work from an earlier, tool-independent point of view; where it or the
`aiworker/*.md` files mention branches, commits, pushes, pull requests, a `../ckb-service-runner` or
`../ckb-revocable-timelock` checkout, or running things on a devnet, **the rules below win**:

* The orchestrator commits and pushes. You never run `git commit`, `git push`, `git tag` or open pull requests.
* You may only touch files inside this directory. Wherever the files say `../ckb-service-runner`, use the
  read-only reference clone `.refs/csr` (create it if it is missing, it is git-ignored):
  `[ -d .refs/csr ] || git clone --depth 1 --branch v0.6.1 https://github.com/ckb-service-runner/ckb-service-runner .refs/csr`.
  CSR v0.6.1 already contains the `random_bytes` host call (7050); nothing needs to change in CSR.
* Nothing runs on a devnet or testnet here (no node binaries, no funds, no Docker). Scripts that need one are
  written and statically checked only; running them is a manual phase at the end of the last project.
* No sudo. Rust lives in the user's home (`$HOME/.cargo`, installed with rustup, minimal profile, stable toolchain,
  target `riscv64imac-unknown-none-elf`). Every shell command that needs `cargo` starts with
  `. "$HOME/.cargo/env"`. The machine has 3 GB RAM: build with `CARGO_BUILD_JOBS=2`, never build in parallel
  with other heavy jobs, and prefer `cargo test` without `--release` unless a phase says otherwise.
* Node 22, npm, Python 3.14 are available. No browser. Tests must run offline once dependencies are installed.
* Record every decision in `DECISIONS.md` (root of the repository), newest at the top, one section per phase.
* No secrets anywhere in the repository. `.gitignore` must contain `target/`, `build/`, `node_modules/`, `.refs/`,
  `.devnet/`, `dist/`.


This project: the TypeScript client `client/` (`@crt/client`) of `aiworker/03-crt-client.md`. Rust parts already exist on this branch and are not touched.

## Phase 1: Primitives

### Instructions
Read `aiworker/03-crt-client.md`, section "Phase 1", the introduction of that file, and the `SPEC.md` sections named there. Implement exactly that phase: file names, signatures and test names as written. Shared vectors are in `spec/vectors/` (protected). Set up `client/` (package.json, tsconfig, the single test runner you choose) and install dependencies with `npm install` inside `client/`.

### Acceptance
```bash
test -f client/package.json
cd client && npm test
```

## Phase 2: Chain access

### Instructions
Read `aiworker/03-crt-client.md`, section "Phase 2", the introduction of that file, and the `SPEC.md` sections named there. Implement exactly that phase: file names, signatures and test names as written. Shared vectors are in `spec/vectors/` (protected). Vendor `csr-job.mjs` from `.refs/csr` as the file describes and write its SHA-256 to `client/vendor/csr-job.sha256` once.

### Acceptance
```bash
test -f client/vendor/csr-job.sha256
cd client && npm test
```

## Phase 3: Transaction builders
model: opus
timeout: 120m

### Instructions
Read `aiworker/03-crt-client.md`, section "Phase 3", the introduction of that file, and the `SPEC.md` sections named there. Implement exactly that phase: file names, signatures and test names as written. Shared vectors are in `spec/vectors/` (protected).

### Acceptance
```bash
cd client && npm test
cd client && npx tsc --noEmit
```

## Phase 4: Descriptor, kit and recovery
model: opus
timeout: 120m

### Instructions
Read `aiworker/03-crt-client.md`, section "Phase 4", the introduction of that file, and the `SPEC.md` sections named there. Implement exactly that phase: file names, signatures and test names as written. Shared vectors are in `spec/vectors/` (protected).

### Acceptance
```bash
cd client && npm test
cd client && npx tsc --noEmit
```

## Phase 5: CLI and documentation

### Instructions
Read `aiworker/03-crt-client.md`, section "Phase 5", the introduction of that file, and the `SPEC.md` sections named there. Implement exactly that phase: file names, signatures and test names as written. Shared vectors are in `spec/vectors/` (protected).

### Acceptance
```bash
node --test acceptance/aiworker-crt-client/
node acceptance/aiworker-crt-client/named.mjs
```
