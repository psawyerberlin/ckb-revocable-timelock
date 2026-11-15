//! In-memory host for the state-machine tests.
use crate::*;
use alloc::collections::{BTreeMap, BTreeSet, VecDeque};
use alloc::vec::Vec;

/// Scripted chain, in-memory kv, fixed block info and deterministic "random" bytes; records the skeleton
/// and the result.
#[derive(Default)]
pub struct MockHost {
    pub payload: Vec<u8>,
    /// Block info as returned by `block_info`.
    pub tip_number: u64,
    pub epoch: u64,
    pub median_time_ms: u64,
    /// `chain_read` answers by `(kind, key)`; absent = 1 (dead / unknown).
    pub chain: BTreeMap<(u64, Vec<u8>), Vec<u8>>,
    /// `cells_query` answers by `(script, script_type)` as out points; absent = empty list.
    pub cells: BTreeMap<(Vec<u8>, u64), Vec<[u8; 36]>>,
    /// Every `cells_query` made, in order.
    pub queries: Vec<(Vec<u8>, u64)>,
    pub kv: BTreeMap<Vec<u8>, Vec<u8>>,
    pub secrets: BTreeSet<Vec<u8>>,
    pub delete_rules: Vec<(Vec<u8>, [u8; 36])>,
    /// Number of `kv_put` calls, successful or not.
    pub kv_put_calls: u32,
    /// Force every `kv_put` to return this code (nothing is stored).
    pub kv_put_fail: Option<u64>,
    /// Chunks returned by `random_bytes` before falling back to the counter-based stream; a chunk shorter
    /// than the request is zero-padded, a longer one truncated.
    pub random_queue: VecDeque<Vec<u8>>,
    pub random_calls: u32,
    random_counter: u64,
    /// The script `load_script_args` parses (molecule `Script`).
    pub script: Vec<u8>,
    /// The deployment data cell.
    pub deployment: Vec<u8>,
    /// Last skeleton / result stored.
    pub skeleton: Option<Vec<u8>>,
    pub result: Option<Vec<u8>>,
    /// Every call in order, by name.
    pub calls: Vec<&'static str>,
}

fn out(data: &[u8], buf: &mut [u8]) -> (u64, u64) {
    copy_partial(data, buf, 0);
    (OK, data.len() as u64)
}

impl MockHost {
    /// Encodes out points as a molecule `OutPointVec`.
    pub fn out_point_vec(points: &[[u8; 36]]) -> Vec<u8> {
        let mut v = Vec::with_capacity(4 + 36 * points.len());
        v.extend_from_slice(&(points.len() as u32).to_le_bytes());
        for p in points {
            v.extend_from_slice(p);
        }
        v
    }
}

impl Host for MockHost {
    fn job_payload(&mut self, buf: &mut [u8]) -> (u64, u64) {
        self.calls.push("job_payload");
        out(&self.payload, buf)
    }
    fn block_info(&mut self, o: &mut [u8; BLOCK_INFO_LEN]) -> u64 {
        self.calls.push("block_info");
        o[..8].copy_from_slice(&self.tip_number.to_le_bytes());
        o[8..16].copy_from_slice(&self.epoch.to_le_bytes());
        o[16..].copy_from_slice(&self.median_time_ms.to_le_bytes());
        OK
    }
    fn chain_read(&mut self, kind: u64, key: &[u8], buf: &mut [u8]) -> (u64, u64) {
        self.calls.push("chain_read");
        if kind > KIND_TRANSACTION {
            return (INVALID, 0);
        }
        match self.chain.get(&(kind, key.to_vec())) {
            Some(d) => out(d, buf),
            None => (MISSING, 0),
        }
    }
    fn cells_query(&mut self, script: &[u8], script_type: u64, buf: &mut [u8]) -> (u64, u64) {
        self.calls.push("cells_query");
        if script_type > SCRIPT_TYPE_TYPE || parse_script_args(script).is_none() {
            return (INVALID, 0);
        }
        self.queries.push((script.to_vec(), script_type));
        let pts = self.cells.get(&(script.to_vec(), script_type)).cloned().unwrap_or_default();
        out(&Self::out_point_vec(&pts[..pts.len().min(64)]), buf)
    }
    fn kv_get(&mut self, key: &[u8], buf: &mut [u8]) -> (u64, u64) {
        self.calls.push("kv_get");
        if key.is_empty() || key.len() > 256 {
            return (INVALID, 0);
        }
        match self.kv.get(key) {
            Some(v) => out(v, buf),
            None => (MISSING, 0),
        }
    }
    fn kv_put(&mut self, key: &[u8], val: &[u8]) -> u64 {
        self.calls.push("kv_put");
        self.kv_put_calls += 1;
        if key.is_empty() {
            return INVALID;
        }
        if key.len() > 256 || val.len() > 1 << 20 {
            return TOO_LARGE;
        }
        if let Some(c) = self.kv_put_fail {
            return c;
        }
        self.kv.insert(key.to_vec(), val.to_vec());
        OK
    }
    fn kv_delete(&mut self, key: &[u8]) -> u64 {
        self.calls.push("kv_delete");
        self.secrets.remove(key);
        if self.kv.remove(key).is_some() {
            OK
        } else {
            MISSING
        }
    }
    fn kv_mark_secret(&mut self, key: &[u8]) -> u64 {
        self.calls.push("kv_mark_secret");
        if self.kv.contains_key(key) {
            self.secrets.insert(key.to_vec());
            OK
        } else {
            MISSING
        }
    }
    fn delete_on_consume(&mut self, key: &[u8], outpoint: &[u8; 36]) -> u64 {
        self.calls.push("delete_on_consume");
        self.delete_rules.push((key.to_vec(), *outpoint));
        OK
    }
    fn random_bytes(&mut self, buf: &mut [u8]) -> u64 {
        self.calls.push("random_bytes");
        if buf.is_empty() {
            return INVALID;
        }
        if buf.len() > 1024 {
            return TOO_LARGE;
        }
        self.random_calls += 1;
        if let Some(chunk) = self.random_queue.pop_front() {
            buf.fill(0);
            let n = chunk.len().min(buf.len());
            buf[..n].copy_from_slice(&chunk[..n]);
            return OK;
        }
        // Deterministic stream: splitmix64 over a counter.
        for b in buf.chunks_mut(8) {
            self.random_counter = self.random_counter.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = self.random_counter;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            z ^= z >> 31;
            b.copy_from_slice(&z.to_le_bytes()[..b.len()]);
        }
        OK
    }
    fn tx_skeleton_put(&mut self, tx: &[u8]) -> u64 {
        self.calls.push("tx_skeleton_put");
        self.skeleton = Some(tx.to_vec());
        OK
    }
    fn result_put(&mut self, data: &[u8]) -> u64 {
        self.calls.push("result_put");
        if data.len() > 65_536 {
            return TOO_LARGE;
        }
        self.result = Some(data.to_vec());
        OK
    }
    fn load_script_args(&mut self, buf: &mut [u8]) -> (u64, u64) {
        self.calls.push("load_script_args");
        match parse_script_args(&self.script) {
            Some(r) => {
                copy_partial(&self.script[r.clone()], buf, 0);
                (OK, r.len() as u64)
            }
            None => (INVALID, 0),
        }
    }
    fn load_deployment_data(&mut self, buf: &mut [u8]) -> (u64, u64) {
        self.calls.push("load_deployment_data");
        out(&self.deployment, buf)
    }
}
