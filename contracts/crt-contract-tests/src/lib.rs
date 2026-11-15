//! Test harness for `crt-node-lock`: deploys `contracts/build/release/crt-node-lock` (built by
//! `scripts/build-contracts.sh`, or by this crate's `build.rs` when the binary is missing) into a `ckb-testtool`
//! context, together with an always-success script that stands in for the owner's lock and the runner wallet.
//!
//! The Alive Cell is a cell dep whose *type* script has `code_hash = TYPE_ID_CODE_HASH`, `hash_type type`,
//! `args = T` and an always-success lock. `ckb-testtool` does not run type scripts of cell deps, so the real
//! type-id semantics are not needed: the lock only looks at the script fields (`SPEC.md` §4.2).

use ckb_testtool::bytes::Bytes;
use ckb_testtool::ckb_error::Error as CkbError;
use ckb_testtool::ckb_types::core::{ScriptHashType, TransactionBuilder, TransactionView};
use ckb_testtool::ckb_types::packed::{self, CellInput, CellOutput, OutPoint, Script};
use ckb_testtool::ckb_types::prelude::*;
use ckb_testtool::context::Context;
use crt_core::{
    ckb_blake2b, pubkey_from_privkey, since_absolute_timestamp, NodeCellData, ALIVE_CELL_DATA,
    GRACE_SECONDS, TYPE_ID_CODE_HASH,
};
use std::path::PathBuf;

/// Cycle limit passed to the verifier (the release budget asserted by the tests is 60 M).
pub const MAX_CYCLES: u64 = 70_000_000;
/// Release-transaction cycle budget (`aiworker/01-crt-contracts.md`, phase 4).
pub const RELEASE_CYCLE_BUDGET: u64 = 60_000_000;
pub const CKB: u64 = 100_000_000;
/// Capacity of the Node Cell in the tests (comfortably above its occupied capacity).
pub const NODE_CAPACITY: u64 = 500 * CKB;
/// Deadline used by the fixtures (unix seconds).
pub const DEADLINE: u64 = 1_800_000_000;

/// Path of the built lock.
pub fn contract_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../build/release/crt-node-lock")
}

pub fn load_lock() -> Bytes {
    let p = contract_path();
    std::fs::read(&p)
        .unwrap_or_else(|e| {
            panic!(
                "cannot read {} ({e}); run scripts/build-contracts.sh",
                p.display()
            )
        })
        .into()
}

/// The `since` of a release input: absolute timestamp `deadline + GRACE_SECONDS`.
pub fn release_since(deadline: u64) -> u64 {
    since_absolute_timestamp(deadline + GRACE_SECONDS)
}

/// Deterministic, valid secp256k1 private key derived from a label.
pub fn test_privkey(label: &[u8]) -> [u8; 32] {
    let d = ckb_blake2b(&[b"crt-contract-tests/privkey", label]);
    pubkey_from_privkey(&d).expect("valid test key");
    d
}

/// A switch: `T`, the runner lock (`R` is its hash), the owner lock, the per-switch key pair and the deadline.
pub struct Switch {
    pub t: [u8; 32],
    pub runner_lock: Script,
    pub owner_lock: Script,
    pub privkey: [u8; 32],
    pub pubkey: [u8; 33],
    pub deadline: u64,
}

impl Switch {
    pub fn r(&self) -> [u8; 32] {
        self.runner_lock.calc_script_hash().unpack()
    }

    pub fn owner_lock_hash(&self) -> [u8; 32] {
        self.owner_lock.calc_script_hash().unpack()
    }

    /// Node Cell data in `state` 0 (no key), 1 (pubkey) or 2 (pubkey and privkey).
    pub fn data(&self, state: u8) -> NodeCellData {
        NodeCellData {
            version: 1,
            state,
            deadline: self.deadline,
            owner_lock_hash: self.owner_lock_hash(),
            descriptor_hash: [0u8; 32],
            pubkey: if state >= 1 { self.pubkey } else { [0u8; 33] },
            privkey: if state >= 2 { self.privkey } else { [0u8; 32] },
        }
    }
}

/// Everything a test needs: a context with the lock and always-success deployed.
pub struct Env {
    pub ctx: Context,
    pub node_lock: OutPoint,
    pub always_success: OutPoint,
}

impl Default for Env {
    fn default() -> Self {
        Self::new()
    }
}

impl Env {
    pub fn new() -> Self {
        let mut ctx = Context::new_with_deterministic_rng();
        let node_lock = ctx.deploy_cell(load_lock());
        let always_success = ctx.deploy_cell(ckb_testtool::builtin::ALWAYS_SUCCESS.clone());
        Env {
            ctx,
            node_lock,
            always_success,
        }
    }

    /// Always-success script with `args` (distinct args give distinct lock hashes).
    pub fn always_success_script(&mut self, args: &[u8]) -> Script {
        self.ctx
            .build_script_with_hash_type(
                &self.always_success,
                ScriptHashType::Data1,
                Bytes::copy_from_slice(args),
            )
            .expect("deployed")
    }

    /// `crt-node-lock` with `hash_type data2` and raw `args` (normally `T ‖ R`).
    pub fn node_lock_script_raw(&mut self, args: &[u8]) -> Script {
        self.ctx
            .build_script_with_hash_type(
                &self.node_lock,
                ScriptHashType::Data2,
                Bytes::copy_from_slice(args),
            )
            .expect("deployed")
    }

    pub fn node_lock_script(&mut self, sw: &Switch) -> Script {
        let mut args = [0u8; 64];
        args[..32].copy_from_slice(&sw.t);
        args[32..].copy_from_slice(&sw.r());
        self.node_lock_script_raw(&args)
    }

    /// A fresh switch with its own runner and owner locks.
    pub fn switch(&mut self) -> Switch {
        let t = ckb_blake2b(&[b"crt-contract-tests/T"]);
        let runner_lock = self.always_success_script(b"runner wallet");
        let owner_lock = self.always_success_script(b"owner");
        let privkey = test_privkey(b"switch");
        let pubkey = pubkey_from_privkey(&privkey).unwrap();
        Switch {
            t,
            runner_lock,
            owner_lock,
            privkey,
            pubkey,
            deadline: DEADLINE,
        }
    }

    pub fn cell(
        &mut self,
        capacity: u64,
        lock: Script,
        type_: Option<Script>,
        data: Bytes,
    ) -> OutPoint {
        self.ctx.create_cell(output(capacity, lock, type_), data)
    }

    /// A live Node Cell of `sw` with `data` (raw bytes, so tests can produce invalid layouts).
    pub fn node_cell(&mut self, sw: &Switch, data: &[u8]) -> OutPoint {
        let lock = self.node_lock_script(sw);
        self.cell(NODE_CAPACITY, lock, None, Bytes::copy_from_slice(data))
    }

    /// A wallet cell of the runner (lock hash `R`).
    pub fn runner_cell(&mut self, sw: &Switch) -> OutPoint {
        self.cell(1_000 * CKB, sw.runner_lock.clone(), None, Bytes::new())
    }

    /// A cell of the owner (lock hash `owner_lock_hash`).
    pub fn owner_cell(&mut self, sw: &Switch) -> OutPoint {
        self.cell(1_000 * CKB, sw.owner_lock.clone(), None, Bytes::new())
    }

    /// The Alive Cell of a switch with Type ID `t_args`: type = type-id script with these args.
    pub fn alive_cell(&mut self, t_args: &[u8]) -> OutPoint {
        let lock = self.always_success_script(b"alive owner");
        let type_ = Script::new_builder()
            .code_hash(TYPE_ID_CODE_HASH.pack())
            .hash_type(ScriptHashType::Type)
            .args(Bytes::copy_from_slice(t_args).pack())
            .build();
        self.cell(
            200 * CKB,
            lock,
            Some(type_),
            Bytes::copy_from_slice(&ALIVE_CELL_DATA),
        )
    }

    /// Completes the code cell deps of the scripts, then verifies; `Ok(cycles)`.
    pub fn verify(&mut self, tx: TransactionView) -> Result<u64, CkbError> {
        let tx = self.ctx.complete_tx(tx);
        self.ctx.verify_tx(&tx, MAX_CYCLES)
    }
}

pub fn output(capacity: u64, lock: Script, type_: Option<Script>) -> CellOutput {
    CellOutput::new_builder()
        .capacity(packed::Uint64::from(capacity))
        .lock(lock)
        .type_(type_.pack())
        .build()
}

pub fn input(op: &OutPoint, since: u64) -> CellInput {
    CellInput::new_builder()
        .previous_output(op.clone())
        .since(packed::Uint64::from(since))
        .build()
}

pub fn cell_dep(op: &OutPoint) -> packed::CellDep {
    packed::CellDep::new_builder().out_point(op.clone()).build()
}

pub fn tx_with(
    inputs: Vec<CellInput>,
    outputs: Vec<(CellOutput, Bytes)>,
    deps: Vec<packed::CellDep>,
) -> TransactionView {
    let (outs, datas): (Vec<_>, Vec<_>) = outputs.into_iter().unzip();
    TransactionBuilder::default()
        .inputs(inputs)
        .outputs(outs)
        .outputs_data(datas.into_iter().map(|d| d.pack()).collect::<Vec<_>>())
        .cell_deps(deps)
        .build()
}

/// Asserts that the transaction is rejected by a script with exit code `code`.
pub fn assert_script_error(res: Result<u64, CkbError>, code: i8) {
    let err = res.expect_err("transaction must be rejected");
    let s = format!("{err:?}");
    assert!(
        s.contains(&format!("error code {code} ")),
        "expected error code {code}: {s}"
    );
}
