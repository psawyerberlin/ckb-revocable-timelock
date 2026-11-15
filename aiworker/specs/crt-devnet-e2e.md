---
project: crt-devnet-e2e
default_model: sonnet
protected_paths: [acceptance/, SPEC.md, AIWORKER.md, aiworker/, spec/vectors/]
source:
  repo: git@github.com:psawyerberlin/ckb-revocable-timelock.git
  ref: main
  key: ckb-revocable-timelock
push:
  branch: aiworker/crt-devnet-e2e
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


This project: devnet end-to-end scripts, cycle budgets and the testnet deployment files of `aiworker/05-crt-devnet-e2e.md`. Everything is written here; running it is the manual phase.

## Phase 1: One-command devnet script

### Instructions
Read `aiworker/05-crt-devnet-e2e.md`, section "Phase 1". Write the scripts and files exactly as described; do NOT run anything that needs a devnet, a node binary or funds. Shell scripts must pass `bash -n` and `--help` must work without side effects.

### Acceptance
```bash
bash -n scripts/devnet-e2e.sh
bash scripts/devnet-e2e.sh --help
```

## Phase 2: The scenario

### Instructions
Read `aiworker/05-crt-devnet-e2e.md`, section "Phase 2". Write the scripts and files exactly as described; do NOT run anything that needs a devnet, a node binary or funds. Shell scripts must pass `bash -n` and `--help` must work without side effects.

### Acceptance
```bash
bash -n scripts/devnet-e2e.sh
node --check scripts/devnet-scenario.mjs
node --test acceptance/aiworker-crt-devnet-e2e/
```

## Phase 3: Testnet deployment files

### Instructions
Read `aiworker/05-crt-devnet-e2e.md`, section "Phase 3". Write the scripts and files exactly as described; do NOT run anything that needs a devnet, a node binary or funds. Shell scripts must pass `bash -n` and `--help` must work without side effects. Write `docs/manual-steps.md` with the exact commands of the manual phase below (devnet run, testnet deployment) and nothing else a human must do.

### Acceptance
```bash
node --test acceptance/aiworker-crt-devnet-e2e/
test -f docs/manual-steps.md
```

## Phase 4: Run the devnet scenario and the testnet deployment (manual)

### Instructions
Manual. On pswsl or the laptop, as the user psawyer, following `docs/manual-steps.md`: (1) `scripts/devnet-service-smoke.sh`, then `scripts/devnet-e2e.sh`, both must print PASS for every step; paste the output into `DECISIONS.md`. (2) With a funded testnet key, run the testnet deployment command of the file, then enable the service on three CSR runners with `scripts/crt-enable.sh`. Mark this phase passed in the web interface when done.

### Acceptance
```bash
true
```
