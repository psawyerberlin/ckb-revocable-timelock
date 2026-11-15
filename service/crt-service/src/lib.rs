//! CRT service for CSR (`SPEC.md` §5). The state machine (`machine::step`) is a pure function over the
//! `crt_host::Host` trait; the binary (`main.rs`) only wires it to the real syscalls.
#![no_std]

extern crate alloc;

pub mod machine;
pub mod tx;

pub use machine::{step, Outcome};
pub use tx::Skeleton;

use crt_host::{Host, OK};

/// Length of the deployment data cell: the field list of `SPEC.md` §5.5 (1 + 1 + 32 + 36 + 32). The prose there
/// says "97 bytes", which does not add up; the struct wins (DECISIONS.md, spec 02 phase 2).
pub const DEPLOYMENT_LEN: usize = 102;
/// Result magic: `"CRT1" ‖ status ‖ T`.
pub const RESULT_MAGIC: &[u8; 4] = b"CRT1";
pub const RESULT_LEN: usize = 37;

/// Per-network constants read from the deployment data cell (cell dep 1 of the virtual transaction).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CrtDeployment {
    pub version: u8,
    pub network_id: u8,
    pub node_lock_code_hash: [u8; 32],
    pub node_lock_outpoint: [u8; 36],
    pub type_id_code_hash: [u8; 32],
}

impl CrtDeployment {
    /// `version u8 = 1, network_id u8, node_lock_code_hash [32], node_lock_outpoint [36], type_id_code_hash [32]`.
    pub fn decode(data: &[u8]) -> Option<Self> {
        if data.len() != DEPLOYMENT_LEN || data[0] != 1 || data[1] > 2 {
            return None;
        }
        let mut d = Self {
            version: data[0],
            network_id: data[1],
            node_lock_code_hash: [0; 32],
            node_lock_outpoint: [0; 36],
            type_id_code_hash: [0; 32],
        };
        d.node_lock_code_hash.copy_from_slice(&data[2..34]);
        d.node_lock_outpoint.copy_from_slice(&data[34..70]);
        d.type_id_code_hash.copy_from_slice(&data[70..102]);
        Some(d)
    }

    pub fn encode(&self) -> [u8; DEPLOYMENT_LEN] {
        let mut out = [0u8; DEPLOYMENT_LEN];
        out[0] = self.version;
        out[1] = self.network_id;
        out[2..34].copy_from_slice(&self.node_lock_code_hash);
        out[34..70].copy_from_slice(&self.node_lock_outpoint);
        out[70..102].copy_from_slice(&self.type_id_code_hash);
        out
    }
}

/// `"CRT1" ‖ status ‖ T`.
pub fn result_bytes(status: u8, t: &[u8; 32]) -> [u8; RESULT_LEN] {
    let mut r = [0u8; RESULT_LEN];
    r[..4].copy_from_slice(RESULT_MAGIC);
    r[4] = status;
    r[5..].copy_from_slice(t);
    r
}

/// One run: load the deployment data cell, then `step`. A missing or malformed data cell means the service
/// was installed wrongly (the manifest names the data cell): reported as `bad_args`, no skeleton.
pub fn run(host: &mut impl Host) -> u8 {
    let mut buf = [0u8; DEPLOYMENT_LEN];
    let (r, len) = host.load_deployment_data(&mut buf);
    match (r == OK && len as usize == DEPLOYMENT_LEN).then(|| CrtDeployment::decode(&buf)).flatten() {
        Some(dep) => step(host, &dep).status,
        None => {
            let t = machine::payload_t(host).unwrap_or([0; 32]);
            host.result_put(&result_bytes(machine::BAD_ARGS, &t));
            machine::BAD_ARGS
        }
    }
}
