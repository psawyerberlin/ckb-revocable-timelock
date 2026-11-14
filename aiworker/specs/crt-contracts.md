---
project: crt-contracts
default_model: sonnet
protected_paths: [acceptance/, SPEC.md, AIWORKER.md, aiworker/, spec/vectors/]
source:
  repo: git@github.com:psawyerberlin/ckb-revocable-timelock.git
  ref: main
  key: ckb-revocable-timelock
push:
  branch: aiworker/crt-contracts
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


This project: the `contracts/` workspace (`crt-core`, `crt-node-lock`, `crt-contract-tests`) of `aiworker/01-crt-contracts.md`.

## Phase 1: Housekeeping, Rust toolchain and workspace
timeout: 60m

### Instructions
Read `aiworker/01-crt-contracts.md`, section "Phase 1", and the `SPEC.md` sections named at the top of that file. Implement exactly that phase: file names, signatures and test names as written there. Before anything else install Rust in user space if `cargo` is missing: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable` then `. "$HOME/.cargo/env" && rustup target add riscv64imac-unknown-none-elf`. Create the CSR reference clone (see above). The housekeeping part of the file is already done in the repository: verify it, do not redo it.

### Acceptance
```bash
. "$HOME/.cargo/env" 2>/dev/null; cargo --version
. "$HOME/.cargo/env" 2>/dev/null; rustup target list --installed | grep -q riscv64imac-unknown-none-elf
node --test --test-name-pattern="phase 1" acceptance/aiworker-crt-contracts/
```

## Phase 2: crt-core library

### Instructions
Read `aiworker/01-crt-contracts.md`, section "Phase 2", and the `SPEC.md` sections named at the top of that file. Implement exactly that phase: file names, signatures and test names as written there.

### Acceptance
```bash
node --test --test-name-pattern="phase [12]" acceptance/aiworker-crt-contracts/
. "$HOME/.cargo/env" 2>/dev/null; cargo test --manifest-path contracts/Cargo.toml -p crt-core
```

## Phase 3: crt-node-lock contract
model: opus
timeout: 120m

### Instructions
Read `aiworker/01-crt-contracts.md`, section "Phase 3", and the `SPEC.md` sections named at the top of that file. Implement exactly that phase: file names, signatures and test names as written there. This is the security-critical part: implement `SPEC.md` section 4 rule by rule, with the error codes of section 4.3, and do not add any code path that the spec does not describe.

### Acceptance
```bash
node --test --test-name-pattern="phase [123]" acceptance/aiworker-crt-contracts/
. "$HOME/.cargo/env" 2>/dev/null; bash scripts/build-contracts.sh
```

## Phase 4: Contract tests
model: opus
timeout: 120m

### Instructions
Read `aiworker/01-crt-contracts.md`, section "Phase 4", and the `SPEC.md` sections named at the top of that file. Implement exactly that phase: file names, signatures and test names as written there.

### Acceptance
```bash
node --test --test-name-pattern="phase [1234]" acceptance/aiworker-crt-contracts/
. "$HOME/.cargo/env" 2>/dev/null; node acceptance/aiworker-crt-contracts/named.mjs
```

## Phase 5: Documentation

### Instructions
Read `aiworker/01-crt-contracts.md`, section "Phase 5", and the `SPEC.md` sections named at the top of that file. Implement exactly that phase: file names, signatures and test names as written there.

### Acceptance
```bash
. "$HOME/.cargo/env" 2>/dev/null; node --test acceptance/aiworker-crt-contracts/
. "$HOME/.cargo/env" 2>/dev/null; node acceptance/aiworker-crt-contracts/named.mjs
```
