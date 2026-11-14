//! `crt-core`: the pure, I/O-free library shared by `crt-node-lock`, the CRT service and the tests.
//!
//! Scaffolding of phase 1 (`aiworker/01-crt-contracts.md`). The constants, `NodeCellData`, the identity and
//! payload helpers and the `k256` key derivation arrive in phase 2.
#![no_std]
#![deny(unsafe_code)]
