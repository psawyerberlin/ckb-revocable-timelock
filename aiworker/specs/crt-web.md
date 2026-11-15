---
project: crt-web
default_model: sonnet
protected_paths: [acceptance/, SPEC.md, AIWORKER.md, aiworker/, spec/vectors/]
source:
  repo: git@github.com:psawyerberlin/ckb-revocable-timelock.git
  ref: main
  key: ckb-revocable-timelock
push:
  branch: aiworker/crt-web
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


This project: the reference web application served at `https://crt.chainsolution.net/app/` (`aiworker/04-crt-web.md`).

## Phase 1: Shell and wallet

### Instructions
Read `aiworker/04-crt-web.md`, section "Phase 1", the introduction of that file, and the `SPEC.md` sections named there. Implement exactly that phase. The explainer site under `site/` is not touched except for the link target `/app/`. Create the Vite project in `web/` and install dependencies there (`npm install` inside `web/`).

### Acceptance
```bash
test -f web/package.json
cd web && npm run build
```

## Phase 2: Create flow

### Instructions
Read `aiworker/04-crt-web.md`, section "Phase 2", the introduction of that file, and the `SPEC.md` sections named there. Implement exactly that phase. The explainer site under `site/` is not touched except for the link target `/app/`.

### Acceptance
```bash
cd web && npm test
cd web && npm run build
```

## Phase 3: Manage and recover

### Instructions
Read `aiworker/04-crt-web.md`, section "Phase 3", the introduction of that file, and the `SPEC.md` sections named there. Implement exactly that phase. The explainer site under `site/` is not touched except for the link target `/app/`.

### Acceptance
```bash
cd web && npm test
cd web && npm run build
```

## Phase 4: Quality and build

### Instructions
Read `aiworker/04-crt-web.md`, section "Phase 4", the introduction of that file, and the `SPEC.md` sections named there. Implement exactly that phase. The explainer site under `site/` is not touched except for the link target `/app/`.

### Acceptance
```bash
node --test acceptance/aiworker-crt-web/
node acceptance/aiworker-crt-web/named.mjs
```
