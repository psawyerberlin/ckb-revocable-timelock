//! `crt-service` binary for CKB-VM inside CSR. Always exits 0: CSR counts a non-zero exit as a service failure
//! and skips the job after three, and a HOLD must never look like a failure (aiworker/02, phase 2).
#![cfg_attr(target_arch = "riscv64", no_std)]
#![cfg_attr(target_arch = "riscv64", no_main)]

#[cfg(target_arch = "riscv64")]
ckb_std::entry!(program_entry);
#[cfg(target_arch = "riscv64")]
ckb_std::default_alloc!();

#[cfg(target_arch = "riscv64")]
fn program_entry() -> i8 {
    // Reads the deployment data cell (`load_cell_data(1, Source::CellDep)`), runs the state machine and
    // writes the skeleton and the result through the host.
    let _ = crt_service::run(&mut crt_host::Syscalls);
    0
}

/// Host builds (`cargo test`) have no CKB-VM entry point.
#[cfg(not(target_arch = "riscv64"))]
fn main() {}
