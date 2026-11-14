---
project: crt-service
default_model: sonnet
protected_paths: [acceptance/, SPEC.md, AIWORKER.md, aiworker/, spec/vectors/]
source:
  repo: git@github.com:psawyerberlin/ckb-revocable-timelock.git
  ref: aiworker/crt-contracts
  key: ckb-revocable-timelock
push:
  branch: aiworker/crt-service
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


This project: the CSR service under `service/` and the operator scripts of `aiworker/02-crt-service.md`. It builds on the branch of project crt-contracts (`crt-core` is already in the repository).

## Phase 1: Host bindings and mock host

### Instructions
Read `aiworker/02-crt-service.md`, section "Phase 1", and the `SPEC.md` sections named at the top of that file. Implement exactly that phase: file names, signatures and test names as written there.

### Acceptance
```bash
node --test --test-name-pattern="phase 1" acceptance/aiworker-crt-service/
```

## Phase 2: State machine
model: opus
timeout: 120m

### Instructions
Read `aiworker/02-crt-service.md`, section "Phase 2", and the `SPEC.md` sections named at the top of that file. Implement exactly that phase: file names, signatures and test names as written there.

### Acceptance
```bash
node --test --test-name-pattern="phase [12]" acceptance/aiworker-crt-service/
. "$HOME/.cargo/env" 2>/dev/null; cargo test --manifest-path service/Cargo.toml -p crt-service --features mock
```

## Phase 3: Service binary, manifest and enable script

### Instructions
Read `aiworker/02-crt-service.md`, section "Phase 3", and the `SPEC.md` sections named at the top of that file. Implement exactly that phase: file names, signatures and test names as written there. If a step of the file needs a running node, write the script and test it only statically.

### Acceptance
```bash
node --test --test-name-pattern="phase [123]" acceptance/aiworker-crt-service/
. "$HOME/.cargo/env" 2>/dev/null; bash scripts/build-service.sh
```

## Phase 4: Devnet smoke script (written, not run)

### Instructions
Read `aiworker/02-crt-service.md`, section "Phase 4", and the `SPEC.md` sections named at the top of that file. Implement exactly that phase: file names, signatures and test names as written there. Write `scripts/devnet-service-smoke.sh` and the helper under `scripts/devnet/` exactly as described, but do NOT run them: there is no devnet here. Make the script pass `bash -n` and support `--help`. The run happens in the manual phase of project crt-devnet-e2e. Ignore the sentence about pasting PASS output into `DECISIONS.md`.

### Acceptance
```bash
node --test --test-name-pattern="phase [1234]" acceptance/aiworker-crt-service/
bash -n scripts/devnet-service-smoke.sh
```

## Phase 5: Documentation

### Instructions
Read `aiworker/02-crt-service.md`, section "Phase 5", and the `SPEC.md` sections named at the top of that file. Implement exactly that phase: file names, signatures and test names as written there.

### Acceptance
```bash
. "$HOME/.cargo/env" 2>/dev/null; node --test acceptance/aiworker-crt-service/
. "$HOME/.cargo/env" 2>/dev/null; node acceptance/aiworker-crt-service/named.mjs
```
