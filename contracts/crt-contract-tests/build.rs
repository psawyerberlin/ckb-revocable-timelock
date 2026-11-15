//! The tests load the lock from `contracts/build/release/crt-node-lock` (`scripts/build-contracts.sh`). If it is
//! missing (e.g. a fresh checkout), this runs the script once, into its own cargo target directory (as CSR does).
use std::path::PathBuf;
use std::process::Command;

const BINARIES: [&str; 1] = ["release/crt-node-lock"];

fn main() {
    let dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let build = dir.join("../build");
    for b in BINARIES {
        println!("cargo:rerun-if-changed={}", build.join(b).display());
    }
    if BINARIES.iter().all(|b| build.join(b).exists()) {
        return;
    }
    let mut cmd = Command::new("bash");
    cmd.arg(dir.join("../../scripts/build-contracts.sh"));
    // the outer cargo's settings for this build script must not leak into the contract build
    for (k, _) in std::env::vars() {
        if (k.starts_with("CARGO_")
            || k == "RUSTFLAGS"
            || k == "RUSTC"
            || k == "RUSTC_WRAPPER"
            || k == "TARGET")
            && k != "CARGO_HOME"
        {
            cmd.env_remove(k);
        }
    }
    cmd.env("CARGO_TARGET_DIR", build.join("cargo-target"));
    let status = cmd.status().expect("run scripts/build-contracts.sh");
    assert!(status.success(), "scripts/build-contracts.sh failed");
}
