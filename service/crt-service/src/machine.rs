//! The CRT state machine, `SPEC.md` §5.3. Pure over `Host`: every input comes from host calls, every effect is
//! a host call (kv, `delete_on_consume`, skeleton, result). No wall clock: only `block_info`'s median time.
use alloc::vec::Vec;

use crt_core::{
    identity, parse_payload, pubkey_from_privkey, since_absolute_timestamp, NodeCellData, GRACE_SECONDS,
    NODE_CELL_DATA_LEN,
};
use crt_host::{
    Host, BLOCK_INFO_LEN, KIND_CELL_DATA, KIND_CELL_OUTPUT, MISSING, OK, SCRIPT_TYPE_LOCK, SCRIPT_TYPE_TYPE,
};

use crate::tx::{parse_cell_output, script, Skeleton, HASH_TYPE_DATA2, HASH_TYPE_TYPE};
use crate::{result_bytes, CrtDeployment};

/// Status bytes of the result (`SPEC.md` §5.3).
pub const HOLD: u8 = 0;
pub const KEYGEN: u8 = 1;
pub const RECOMMIT: u8 = 2;
pub const RELEASE: u8 = 3;
pub const DONE: u8 = 4;
pub const CANCELLED: u8 = 5;
pub const DROPPED: u8 = 6;
pub const KEY_LOST: u8 = 7;
pub const BAD_ARGS: u8 = 8;
pub const BAD_PAYLOAD: u8 = 9;

/// KEYGEN draws at most this many 32-byte candidates before giving up with `key_lost`.
pub const MAX_KEY_DRAWS: u32 = 8;
/// `cells_query` answers at most 64 out points.
const QUERY_BUF: usize = 4 + 36 * 64;
/// A Node Cell output is ~130 bytes (no type script); anything above this is not a Node Cell.
const OUTPUT_BUF: usize = 1024;
/// Largest `since` timestamp value (56 bits).
const SINCE_VALUE_MAX: u64 = 0x00ff_ffff_ffff_ffff;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome {
    pub status: u8,
    pub skeleton: Option<Skeleton>,
}

/// One run of the service. Writes the skeleton (only when there is one: "empty skeleton" = never calls
/// `tx_skeleton_put`) and always the 37-byte result `"CRT1" ‖ status ‖ T`.
pub fn step(host: &mut impl Host, deployment: &CrtDeployment) -> Outcome {
    let (status, t, skeleton) = decide(host, deployment);
    if let Some(s) = &skeleton {
        host.tx_skeleton_put(&s.to_molecule());
    }
    host.result_put(&result_bytes(status, &t));
    Outcome { status, skeleton }
}

/// `T` from the job payload `"CRTS" ‖ 0x01 ‖ T`, if it is well-formed.
pub fn payload_t(host: &mut impl Host) -> Option<[u8; 32]> {
    let mut p = [0u8; 37];
    let (r, len) = host.job_payload(&mut p);
    if r != OK || len != 37 {
        return None;
    }
    parse_payload(&p).ok()
}

/// A Node Cell as read from the chain.
struct Node {
    outpoint: [u8; 36],
    output: Vec<u8>,
    data: NodeCellData,
}

enum NodeLookup {
    Found(Node),
    /// No live cell with exactly this lock.
    None,
    /// A queried cell was gone when read (lost race): try again next run, delete nothing.
    Raced,
    /// Undecodable data, or several Node Cells whose data disagree.
    Bad,
}

fn decide(host: &mut impl Host, dep: &CrtDeployment) -> (u8, [u8; 32], Option<Skeleton>) {
    let payload = payload_t(host);
    let t_or_zero = payload.unwrap_or([0; 32]);

    let mut r = [0u8; 32];
    let (code, len) = host.load_script_args(&mut r);
    if code != OK || len != 32 {
        return (BAD_ARGS, t_or_zero, None);
    }
    let Some(t) = payload else {
        return (BAD_PAYLOAD, t_or_zero, None);
    };
    let i = identity(dep.network_id, &t);

    // Alive Cell: type-id type script with args T.
    let alive = match query(host, &script(&dep.type_id_code_hash, HASH_TYPE_TYPE, &t), SCRIPT_TYPE_TYPE) {
        Some(v) => v,
        None => return (BAD_PAYLOAD, t, None),
    };
    let Some(&alive_op) = alive.first() else {
        host.kv_delete(&i);
        return (CANCELLED, t, None);
    };

    // Node Cell: crt-node-lock, data2, args T ‖ R.
    let mut args = [0u8; 64];
    args[..32].copy_from_slice(&t);
    args[32..].copy_from_slice(&r);
    let node_lock = script(&dep.node_lock_code_hash, HASH_TYPE_DATA2, &args);
    let node = match find_node(host, &node_lock) {
        NodeLookup::Found(n) => n,
        NodeLookup::None => {
            host.kv_delete(&i);
            return (DROPPED, t, None);
        }
        NodeLookup::Raced => return (HOLD, t, None),
        NodeLookup::Bad => return (BAD_PAYLOAD, t, None),
    };

    // Stored key, if any. Present with a wrong length = corrupt (never overwritten).
    let mut d = [0u8; 32];
    let (code, len) = host.kv_get(&i, &mut d);
    let stored = match code {
        OK if len == 32 => Some(Ok(d)),
        OK => Some(Err(())),
        MISSING => None,
        _ => return (BAD_PAYLOAD, t, None),
    };

    match node.data.state {
        0 => {
            let (status, d) = match stored {
                Some(Ok(d)) => (RECOMMIT, d),
                Some(Err(())) => return (KEY_LOST, t, None),
                None => match keygen(host, &i, &alive_op) {
                    Some(d) => (KEYGEN, d),
                    None => return (KEY_LOST, t, None),
                },
            };
            let Ok(p) = pubkey_from_privkey(&d) else {
                return (KEY_LOST, t, None);
            };
            let mut out = node.data.clone();
            out.state = 1;
            out.pubkey = p;
            out.privkey = [0; 32];
            (status, t, Some(skeleton(&node, &out, 0, &[dep.node_lock_outpoint])))
        }
        1 => {
            let d = match stored {
                Some(Ok(d)) => d,
                _ => return (KEY_LOST, t, None),
            };
            let mut bi = [0u8; BLOCK_INFO_LEN];
            if host.block_info(&mut bi) != OK {
                return (HOLD, t, None);
            }
            let mut m = [0u8; 8];
            m.copy_from_slice(&bi[16..24]);
            let now = u64::from_le_bytes(m) / 1000;
            let due = match node.data.deadline.checked_add(GRACE_SECONDS) {
                Some(due) if due <= SINCE_VALUE_MAX => due,
                _ => return (HOLD, t, None), // never reachable on chain
            };
            if now < due {
                return (HOLD, t, None);
            }
            // Never publish a key that does not open this commitment (a lookalike cell, a corrupt kv).
            if pubkey_from_privkey(&d) != Ok(node.data.pubkey) {
                return (KEY_LOST, t, None);
            }
            let mut out = node.data.clone();
            out.state = 2;
            out.privkey = d;
            let since = since_absolute_timestamp(due);
            (RELEASE, t, Some(skeleton(&node, &out, since, &[dep.node_lock_outpoint, alive_op])))
        }
        _ => {
            host.kv_delete(&i);
            (DONE, t, None)
        }
    }
}

/// `random_bytes(32)` until `0 < d < n` (at most `MAX_KEY_DRAWS`), then store, mark secret and tie the entry
/// to the Alive Cell. `None` (no kv write at all, or a failed write) → `key_lost`.
fn keygen(host: &mut impl Host, i: &[u8; 32], alive_op: &[u8; 36]) -> Option<[u8; 32]> {
    let mut d = [0u8; 32];
    let mut ok = false;
    for _ in 0..MAX_KEY_DRAWS {
        if host.random_bytes(&mut d) == OK && pubkey_from_privkey(&d).is_ok() {
            ok = true;
            break;
        }
    }
    if !ok || host.kv_put(i, &d) != OK {
        return None;
    }
    host.kv_mark_secret(i);
    host.delete_on_consume(i, alive_op);
    Some(d)
}

fn skeleton(node: &Node, out: &NodeCellData, since: u64, deps: &[[u8; 36]]) -> Skeleton {
    Skeleton {
        input: node.outpoint,
        since,
        output: node.output.clone(),
        output_data: out.encode().to_vec(),
        cell_deps: deps.to_vec(),
    }
}

/// `cells_query` → out points; `None` on a host error or a malformed answer.
fn query(host: &mut impl Host, script: &[u8], script_type: u64) -> Option<Vec<[u8; 36]>> {
    let mut buf = [0u8; QUERY_BUF];
    let (r, len) = host.cells_query(script, script_type, &mut buf);
    let len = len as usize;
    if r != OK || len < 4 || len > QUERY_BUF {
        return None;
    }
    let n = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
    if len != 4 + 36 * n {
        return None;
    }
    Some(
        buf[4..len]
            .chunks_exact(36)
            .map(|c| {
                let mut op = [0u8; 36];
                op.copy_from_slice(c);
                op
            })
            .collect(),
    )
}

/// Reads every candidate of the lock query (normally exactly one: two `chain_read`s). Candidates whose lock is
/// not exactly `node_lock` (args are prefix-matched) are ignored. Index 0 of the rest is the Node Cell; if
/// another one carries different data the run refuses (`bad_payload`, see DECISIONS.md).
fn find_node(host: &mut impl Host, node_lock: &[u8]) -> NodeLookup {
    let Some(candidates) = query(host, node_lock, SCRIPT_TYPE_LOCK) else {
        return NodeLookup::Bad;
    };
    let mut first: Option<(Node, [u8; NODE_CELL_DATA_LEN])> = None;
    let mut raced = false;
    for op in candidates {
        let mut ob = [0u8; OUTPUT_BUF];
        let (r, len) = host.chain_read(KIND_CELL_OUTPUT, &op, &mut ob);
        if r == MISSING {
            raced = true;
            continue;
        }
        let len = len as usize;
        if r != OK || len > OUTPUT_BUF {
            continue;
        }
        let output = &ob[..len];
        match parse_cell_output(output) {
            Some((_, lock)) if &output[lock.clone()] == node_lock => {}
            _ => continue,
        }
        let mut db = [0u8; NODE_CELL_DATA_LEN + 1];
        let (r, dlen) = host.chain_read(KIND_CELL_DATA, &op, &mut db);
        if r == MISSING {
            raced = true;
            continue;
        }
        if r != OK || dlen as usize != NODE_CELL_DATA_LEN {
            return NodeLookup::Bad;
        }
        let mut raw = [0u8; NODE_CELL_DATA_LEN];
        raw.copy_from_slice(&db[..NODE_CELL_DATA_LEN]);
        match &first {
            Some((_, seen)) => {
                if *seen != raw {
                    return NodeLookup::Bad;
                }
            }
            None => {
                let Ok(data) = NodeCellData::decode(&raw) else {
                    return NodeLookup::Bad;
                };
                first = Some((Node { outpoint: op, output: output.to_vec(), data }, raw));
            }
        }
    }
    match first {
        Some((n, _)) => NodeLookup::Found(n),
        None if raced => NodeLookup::Raced,
        None => NodeLookup::None,
    }
}

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;
    use crate::tx::DEP_TYPE_CODE;
    use alloc::vec;
    use ckb_types::{packed, prelude::*};
    use crt_core::TYPE_ID_CODE_HASH;
    use crt_host::MockHost;

    const T: [u8; 32] = [0x11; 32];
    const R: [u8; 32] = [0x22; 32];
    const DEADLINE: u64 = 1_800_000_000;
    const DUE: u64 = DEADLINE + GRACE_SECONDS;
    const CAPACITY: u64 = 244_0000_0000;
    const ALIVE_OP: [u8; 36] = [0xa1; 36];
    const NODE_OP: [u8; 36] = [0xb2; 36];
    const D: [u8; 32] = {
        let mut d = [0x5c; 32];
        d[0] = 0x01;
        d
    };

    fn dep() -> CrtDeployment {
        CrtDeployment {
            version: 1,
            network_id: 2,
            node_lock_code_hash: [0x33; 32],
            node_lock_outpoint: [0x44; 36],
            type_id_code_hash: TYPE_ID_CODE_HASH,
        }
    }

    fn i() -> [u8; 32] {
        identity(2, &T)
    }

    fn payload() -> Vec<u8> {
        let mut p = b"CRTS\x01".to_vec();
        p.extend_from_slice(&T);
        p
    }

    fn node_lock() -> Vec<u8> {
        let mut a = T.to_vec();
        a.extend_from_slice(&R);
        script(&dep().node_lock_code_hash, HASH_TYPE_DATA2, &a)
    }

    fn cell_output(capacity: u64, lock: &[u8]) -> Vec<u8> {
        let total = 16 + 8 + lock.len();
        let mut v = Vec::new();
        for x in [total as u32, 16, 24, total as u32] {
            v.extend_from_slice(&x.to_le_bytes());
        }
        v.extend_from_slice(&capacity.to_le_bytes());
        v.extend_from_slice(lock);
        v
    }

    fn node_data(state: u8) -> NodeCellData {
        NodeCellData {
            version: 1,
            state,
            deadline: DEADLINE,
            owner_lock_hash: [0x55; 32],
            descriptor_hash: if state == 0 { [0; 32] } else { [0x66; 32] },
            pubkey: if state == 0 { [0; 33] } else { pubkey_from_privkey(&D).unwrap() },
            privkey: if state == 2 { D } else { [0; 32] },
        }
    }

    fn add_node(h: &mut MockHost, op: [u8; 36], data: &NodeCellData) {
        h.cells.entry((node_lock(), SCRIPT_TYPE_LOCK)).or_default().push(op);
        h.chain.insert((KIND_CELL_OUTPUT, op.to_vec()), cell_output(CAPACITY, &node_lock()));
        h.chain.insert((KIND_CELL_DATA, op.to_vec()), data.encode().to_vec());
    }

    /// A runner `R`, a switch `T` with a live Alive Cell and one Node Cell in `state`.
    fn host(state: u8) -> MockHost {
        let mut h = MockHost::default();
        h.script = script(&[0x77; 32], HASH_TYPE_DATA2, &R);
        h.payload = payload();
        h.median_time_ms = (DEADLINE - 3600) * 1000;
        h.cells.insert((script(&TYPE_ID_CODE_HASH, HASH_TYPE_TYPE, &T), SCRIPT_TYPE_TYPE), vec![ALIVE_OP]);
        add_node(&mut h, NODE_OP, &node_data(state));
        h
    }

    fn with_key(mut h: MockHost) -> MockHost {
        h.kv.insert(i().to_vec(), D.to_vec());
        h.secrets.insert(i().to_vec());
        h
    }

    fn decode_tx(h: &MockHost) -> packed::Transaction {
        let b = h.skeleton.as_ref().expect("skeleton written");
        packed::TransactionReader::verify(b, false).expect("valid molecule Transaction");
        packed::Transaction::from_slice(b).unwrap()
    }

    fn out_data(o: &Outcome) -> NodeCellData {
        NodeCellData::decode(&o.skeleton.as_ref().unwrap().output_data).unwrap()
    }

    fn result_status(h: &MockHost) -> u8 {
        h.result.as_ref().unwrap()[4]
    }

    fn pos(h: &MockHost, call: &str) -> usize {
        h.calls.iter().position(|c| *c == call).unwrap_or_else(|| panic!("{call} not called"))
    }

    #[test]
    fn hold_before_deadline() {
        let mut h = with_key(host(1));
        let o = step(&mut h, &dep());
        assert_eq!(o, Outcome { status: HOLD, skeleton: None });
        assert!(h.skeleton.is_none());
        assert_eq!(result_status(&h), HOLD);
        assert!(h.kv.contains_key(&i().to_vec()));
        // HOLD is cheap: one cells_query per cell kind, two chain_reads, no EC work, no writes.
        assert_eq!(h.calls.iter().filter(|c| **c == "chain_read").count(), 2);
        assert_eq!(h.kv_put_calls, 0);
        assert_eq!(h.random_calls, 0);
        // Past the deadline but inside GRACE: still HOLD.
        h.median_time_ms = (DEADLINE + 1) * 1000;
        assert_eq!(step(&mut h, &dep()).status, HOLD);
    }

    #[test]
    fn keygen_stores_key_and_commits() {
        let mut h = host(0);
        let o = step(&mut h, &dep());
        assert_eq!(o.status, KEYGEN);
        let d: [u8; 32] = h.kv.get(&i().to_vec()).expect("key stored").clone().try_into().unwrap();
        let out = out_data(&o);
        assert_eq!(out.state, 1);
        assert_eq!(out.pubkey, pubkey_from_privkey(&d).unwrap());
        assert_eq!(out.privkey, [0; 32]);
        assert_eq!(out.deadline, DEADLINE);
        assert_eq!(out.owner_lock_hash, [0x55; 32]);
        let s = o.skeleton.as_ref().unwrap();
        assert_eq!(s.input, NODE_OP);
        assert_eq!(s.since, 0);
        assert_eq!(s.cell_deps, vec![dep().node_lock_outpoint]);
        assert_eq!(h.skeleton.as_ref().unwrap(), &s.to_molecule());
        // Stored before the skeleton is handed over.
        assert!(pos(&h, "kv_put") < pos(&h, "tx_skeleton_put"));
        assert_eq!(h.kv_put_calls, 1);
        assert_eq!(result_status(&h), KEYGEN);
    }

    #[test]
    fn keygen_sets_delete_on_consume_on_alive_cell() {
        let mut h = host(0);
        step(&mut h, &dep());
        assert_eq!(h.delete_rules, vec![(i().to_vec(), ALIVE_OP)]);
    }

    #[test]
    fn keygen_marks_secret() {
        let mut h = host(0);
        step(&mut h, &dep());
        assert!(h.secrets.contains(&i().to_vec()));
        assert!(pos(&h, "kv_put") < pos(&h, "kv_mark_secret"));
    }

    #[test]
    fn keygen_redraws_out_of_range_scalar() {
        let mut h = host(0);
        h.random_queue.push_back(vec![0; 32]); // 0
        h.random_queue.push_back(vec![0xff; 32]); // ≥ n
        h.random_queue.push_back(D.to_vec());
        assert_eq!(step(&mut h, &dep()).status, KEYGEN);
        assert_eq!(h.random_calls, 3);
        assert_eq!(h.kv.get(&i().to_vec()).unwrap(), &D.to_vec());
    }

    #[test]
    fn recommit_reuses_stored_key() {
        let mut h = with_key(host(0));
        let o = step(&mut h, &dep());
        assert_eq!(o.status, RECOMMIT);
        assert_eq!(out_data(&o).pubkey, pubkey_from_privkey(&D).unwrap());
        assert_eq!(out_data(&o).state, 1);
        assert_eq!(h.kv.get(&i().to_vec()).unwrap(), &D.to_vec());
        assert_eq!(result_status(&h), RECOMMIT);
    }

    #[test]
    fn recommit_never_regenerates() {
        let mut h = with_key(host(0));
        let first = step(&mut h, &dep());
        let second = step(&mut h, &dep());
        assert_eq!(first, second);
        assert_eq!(h.kv_put_calls, 0);
        assert_eq!(h.random_calls, 0);
        assert!(!h.calls.contains(&"kv_put"));
        // A KEYGEN followed by a failed commit (Node Cell still state 0) recommits the same key.
        let mut h = host(0);
        let k = step(&mut h, &dep());
        let r = step(&mut h, &dep());
        assert_eq!((k.status, r.status), (KEYGEN, RECOMMIT));
        assert_eq!(out_data(&k).pubkey, out_data(&r).pubkey);
        assert_eq!(h.kv_put_calls, 1);
        assert_eq!(h.random_calls, 1);
    }

    #[test]
    fn release_at_deadline_plus_grace() {
        let mut h = with_key(host(1));
        h.median_time_ms = DUE * 1000;
        let o = step(&mut h, &dep());
        assert_eq!(o.status, RELEASE);
        let out = out_data(&o);
        assert_eq!(out.state, 2);
        assert_eq!(out.privkey, D);
        assert_eq!(out.pubkey, pubkey_from_privkey(&D).unwrap());
        assert_eq!(out.descriptor_hash, [0x66; 32]);
        assert_eq!(result_status(&h), RELEASE);
        // The key stays until DONE.
        assert!(h.kv.contains_key(&i().to_vec()));
    }

    #[test]
    fn release_not_one_second_early() {
        for ms in [(DUE - 1) * 1000, DUE * 1000 - 1] {
            let mut h = with_key(host(1));
            h.median_time_ms = ms;
            assert_eq!(step(&mut h, &dep()), Outcome { status: HOLD, skeleton: None });
            assert!(h.skeleton.is_none());
        }
    }

    #[test]
    fn release_skeleton_has_alive_dep_and_since() {
        let mut h = with_key(host(1));
        h.median_time_ms = (DUE + 500) * 1000;
        let o = step(&mut h, &dep());
        let s = o.skeleton.as_ref().unwrap();
        assert_eq!(s.since, 0x4000_0000_0000_0000 | DUE, "since = deadline + GRACE, not now");
        assert_eq!(s.cell_deps, vec![dep().node_lock_outpoint, ALIVE_OP]);
        let tx = decode_tx(&h);
        let raw = tx.raw();
        assert_eq!(raw.inputs().len(), 1);
        let input = raw.inputs().get(0).unwrap();
        assert_eq!(input.since().as_slice(), &(0x4000_0000_0000_0000u64 | DUE).to_le_bytes());
        assert_eq!(input.previous_output().as_slice(), &NODE_OP);
        assert_eq!(raw.cell_deps().len(), 2);
        let alive = raw.cell_deps().get(1).unwrap();
        assert_eq!(alive.out_point().as_slice(), &ALIVE_OP);
        assert_eq!(alive.dep_type().as_slice(), &[DEP_TYPE_CODE]);
    }

    #[test]
    fn done_deletes_key() {
        let mut h = with_key(host(2));
        let o = step(&mut h, &dep());
        assert_eq!(o, Outcome { status: DONE, skeleton: None });
        assert!(h.kv.is_empty());
        assert!(h.secrets.is_empty());
        assert!(h.skeleton.is_none());
        assert_eq!(result_status(&h), DONE);
        // Idempotent: a second run still says DONE.
        assert_eq!(step(&mut h, &dep()).status, DONE);
    }

    #[test]
    fn cancelled_deletes_key_and_empty_skeleton() {
        let mut h = with_key(host(1));
        h.cells.remove(&(script(&TYPE_ID_CODE_HASH, HASH_TYPE_TYPE, &T), SCRIPT_TYPE_TYPE));
        let o = step(&mut h, &dep());
        assert_eq!(o, Outcome { status: CANCELLED, skeleton: None });
        assert!(h.kv.is_empty());
        assert!(h.skeleton.is_none());
        assert!(!h.calls.contains(&"tx_skeleton_put"));
        assert_eq!(result_status(&h), CANCELLED);
    }

    #[test]
    fn dropped_deletes_key() {
        let mut h = with_key(host(1));
        h.cells.remove(&(node_lock(), SCRIPT_TYPE_LOCK));
        let o = step(&mut h, &dep());
        assert_eq!(o, Outcome { status: DROPPED, skeleton: None });
        assert!(h.kv.is_empty());
        assert!(h.skeleton.is_none());
        assert_eq!(result_status(&h), DROPPED);
        // A cell whose args merely start with T ‖ R (prefix match) is not a Node Cell.
        let mut h = with_key(host(1));
        let mut long = T.to_vec();
        long.extend_from_slice(&R);
        long.push(0);
        let op = [0xc3; 36];
        h.cells.insert((node_lock(), SCRIPT_TYPE_LOCK), vec![op]);
        let lock = script(&dep().node_lock_code_hash, HASH_TYPE_DATA2, &long);
        h.chain.insert((KIND_CELL_OUTPUT, op.to_vec()), cell_output(CAPACITY, &lock));
        h.chain.insert((KIND_CELL_DATA, op.to_vec()), node_data(1).encode().to_vec());
        assert_eq!(step(&mut h, &dep()).status, DROPPED);
    }

    #[test]
    fn lost_race_holds_and_keeps_key() {
        let mut h = with_key(host(1));
        h.chain.remove(&(KIND_CELL_OUTPUT, NODE_OP.to_vec()));
        assert_eq!(step(&mut h, &dep()).status, HOLD);
        assert!(h.kv.contains_key(&i().to_vec()));
    }

    #[test]
    fn key_lost_reports_without_skeleton() {
        // State 1 without a stored key.
        let mut h = host(1);
        h.median_time_ms = DUE * 1000;
        assert_eq!(step(&mut h, &dep()), Outcome { status: KEY_LOST, skeleton: None });
        assert!(h.skeleton.is_none());
        assert_eq!(result_status(&h), KEY_LOST);
        // Eight bad draws: no kv write at all.
        let mut h = host(0);
        for _ in 0..MAX_KEY_DRAWS {
            h.random_queue.push_back(vec![0; 32]);
        }
        assert_eq!(step(&mut h, &dep()), Outcome { status: KEY_LOST, skeleton: None });
        assert_eq!(h.kv_put_calls, 0);
        assert!(h.delete_rules.is_empty());
        // Quota exceeded: nothing committed.
        let mut h = host(0);
        h.kv_put_fail = Some(crt_host::QUOTA_EXCEEDED);
        assert_eq!(step(&mut h, &dep()), Outcome { status: KEY_LOST, skeleton: None });
        // A stored key that does not open the commitment is never published.
        let mut h = host(1);
        let mut other = D;
        other[31] ^= 1;
        h.kv.insert(i().to_vec(), other.to_vec());
        h.median_time_ms = DUE * 1000;
        assert_eq!(step(&mut h, &dep()), Outcome { status: KEY_LOST, skeleton: None });
        assert!(h.skeleton.is_none());
    }

    #[test]
    fn bad_payload_reports() {
        let mut h = with_key(host(1));
        h.payload[4] = 2;
        assert_eq!(step(&mut h, &dep()), Outcome { status: BAD_PAYLOAD, skeleton: None });
        assert_eq!(h.result.as_ref().unwrap()[5..], [0u8; 32]);
        assert!(!h.calls.contains(&"kv_delete"));
        let mut h = host(1);
        h.payload.pop();
        assert_eq!(step(&mut h, &dep()).status, BAD_PAYLOAD);
        // Two Node Cells for T ‖ R whose data disagree (e.g. a lookalike with an earlier deadline).
        let mut h = with_key(host(0));
        let mut fake = node_data(0);
        fake.deadline = 1;
        add_node(&mut h, [0xd4; 36], &fake);
        assert_eq!(step(&mut h, &dep()), Outcome { status: BAD_PAYLOAD, skeleton: None });
        assert!(h.skeleton.is_none());
        // Identical copies: index 0 is used.
        let mut h = with_key(host(0));
        add_node(&mut h, [0xd4; 36], &node_data(0));
        let o = step(&mut h, &dep());
        assert_eq!(o.status, RECOMMIT);
        assert_eq!(o.skeleton.unwrap().input, NODE_OP);
        // Undecodable Node Cell data.
        let mut h = with_key(host(1));
        h.chain.insert((KIND_CELL_DATA, NODE_OP.to_vec()), vec![9; 139]);
        assert_eq!(step(&mut h, &dep()).status, BAD_PAYLOAD);
    }

    #[test]
    fn bad_args_reports() {
        for args in [vec![], vec![0x22; 20], vec![0x22; 33], vec![0x22; 64]] {
            let mut h = with_key(host(1));
            h.script = script(&[0x77; 32], HASH_TYPE_DATA2, &args);
            assert_eq!(step(&mut h, &dep()), Outcome { status: BAD_ARGS, skeleton: None });
            assert!(h.skeleton.is_none());
            assert_eq!(h.result.as_ref().unwrap()[5..], T);
            assert!(!h.calls.iter().any(|c| c.starts_with("kv_") || *c == "cells_query"));
        }
        // Missing deployment data cell (run()).
        let mut h = host(1);
        assert_eq!(crate::run(&mut h), BAD_ARGS);
        assert_eq!(result_status(&h), BAD_ARGS);
        h.deployment = dep().encode().to_vec();
        assert_eq!(crate::run(&mut h), KEY_LOST);
    }

    #[test]
    fn result_format_is_crt1_status_t() {
        let mut cases: Vec<(MockHost, u8)> = vec![
            (with_key(host(1)), HOLD),
            (host(0), KEYGEN),
            (with_key(host(0)), RECOMMIT),
            (with_key(host(2)), DONE),
            (host(1), KEY_LOST),
        ];
        let mut rel = with_key(host(1));
        rel.median_time_ms = DUE * 1000;
        cases.push((rel, RELEASE));
        let mut c = host(1);
        c.cells.clear();
        cases.push((c, CANCELLED));
        let mut d = host(1);
        d.cells.remove(&(node_lock(), SCRIPT_TYPE_LOCK));
        cases.push((d, DROPPED));
        let mut a = host(1);
        a.script = script(&[0; 32], 2, &[1]);
        cases.push((a, BAD_ARGS));
        for (mut h, want) in cases {
            assert_eq!(step(&mut h, &dep()).status, want);
            let r = h.result.as_ref().unwrap();
            assert_eq!(r.len(), 37);
            assert_eq!(&r[..4], b"CRT1");
            assert_eq!(r[4], want);
            assert_eq!(r[5..], T);
            assert_eq!(h.calls.iter().filter(|c| **c == "result_put").count(), 1);
        }
    }

    #[test]
    fn skeleton_capacity_unchanged() {
        let mut k = host(0);
        let mut rel = with_key(host(1));
        rel.median_time_ms = DUE * 1000;
        for h in [&mut k, &mut rel] {
            step(h, &dep());
            let tx = decode_tx(h);
            assert_eq!(tx.raw().outputs().len(), 1);
            let out = tx.raw().outputs().get(0).unwrap();
            assert_eq!(out.capacity().as_slice(), &CAPACITY.to_le_bytes());
            assert_eq!(out.lock().as_slice(), node_lock().as_slice());
            assert!(out.type_().to_opt().is_none());
            assert_eq!(out.as_slice(), cell_output(CAPACITY, &node_lock()).as_slice());
        }
    }

    #[test]
    fn skeleton_molecule_decodes() {
        let mut k = host(0);
        let mut rel = with_key(host(1));
        rel.median_time_ms = DUE * 1000;
        for (h, ndeps) in [(&mut k, 1usize), (&mut rel, 2)] {
            let o = step(h, &dep());
            let tx = decode_tx(h);
            let raw = tx.raw();
            assert_eq!(raw.version().as_slice(), &0u32.to_le_bytes());
            assert_eq!(raw.header_deps().len(), 0);
            assert_eq!(raw.inputs().len(), 1);
            assert_eq!(raw.outputs().len(), 1);
            assert_eq!(raw.outputs_data().len(), 1);
            assert_eq!(raw.outputs_data().get(0).unwrap().raw_data().as_ref(), &o.skeleton.as_ref().unwrap().output_data[..]);
            assert_eq!(raw.cell_deps().len(), ndeps);
            let code = raw.cell_deps().get(0).unwrap();
            assert_eq!(code.out_point().as_slice(), &dep().node_lock_outpoint);
            assert_eq!(code.dep_type().as_slice(), &[DEP_TYPE_CODE]);
            assert_eq!(tx.witnesses().len(), 1);
            assert!(tx.witnesses().get(0).unwrap().raw_data().is_empty());
            // Strict decode too.
            packed::TransactionReader::verify(h.skeleton.as_ref().unwrap(), false).unwrap();
        }
    }
}
