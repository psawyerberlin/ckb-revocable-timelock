//! `crt-node-lock`, args = `T (32) ‖ R (32)`. Implements `SPEC.md` §4 (phase 3 of `aiworker/01-crt-contracts.md`).
//!
//! Phase 1 scaffolding: the script builds for `riscv64imac-unknown-none-elf` and **rejects every unlock**
//! (fail closed) until the rules of §4 are implemented. Never deploy this build.
#![no_std]
#![no_main]

ckb_std::entry!(program_entry);
ckb_std::default_alloc!();

/// Placeholder exit code of the unimplemented lock; not one of the codes of `SPEC.md` §4.3.
const ERR_NOT_IMPLEMENTED: i8 = 127;

fn program_entry() -> i8 {
    ERR_NOT_IMPLEMENTED
}
