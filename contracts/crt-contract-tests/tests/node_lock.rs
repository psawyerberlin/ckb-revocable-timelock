//! Transaction tests of `crt-node-lock` (`SPEC.md` §4, test names fixed by `aiworker/01-crt-contracts.md` phase 4).

use ckb_testtool::bytes::Bytes;
use ckb_testtool::ckb_types::core::TransactionView;
use crt_contract_tests::*;
use crt_core::{
    identity, parse_payload, pubkey_from_privkey, since_absolute_timestamp, NodeCellData,
    GRACE_SECONDS,
};

/// A node-path transaction: input Node Cell with `in_data` and `since`, an optional runner wallet input,
/// `outs` Node Cell outputs `(capacity, data)` with the same lock, the runner's change, and cell deps `deps`.
fn node_tx(
    env: &mut Env,
    sw: &Switch,
    in_data: &[u8],
    since: u64,
    outs: &[(u64, Vec<u8>)],
    runner: bool,
    deps: &[ckb_testtool::ckb_types::packed::OutPoint],
) -> TransactionView {
    let node = env.node_cell(sw, in_data);
    let lock = env.node_lock_script(sw);
    let mut inputs = vec![input(&node, since)];
    let mut outputs: Vec<_> = outs
        .iter()
        .map(|(cap, d)| (output(*cap, lock.clone(), None), Bytes::copy_from_slice(d)))
        .collect();
    if runner {
        let wallet = env.runner_cell(sw);
        inputs.push(input(&wallet, 0));
        outputs.push((
            output(999 * CKB, sw.runner_lock.clone(), None),
            Bytes::new(),
        ));
    }
    tx_with(inputs, outputs, deps.iter().map(cell_dep).collect())
}

fn enc(d: &NodeCellData) -> Vec<u8> {
    d.encode().to_vec()
}

/// An owner-path transaction: the Node Cell (state 1), the owner's cell, and `out` (if any) as the new Node Cell.
fn owner_tx(env: &mut Env, sw: &Switch, out: Option<NodeCellData>) -> TransactionView {
    let node = env.node_cell(sw, &enc(&sw.data(1)));
    let owner = env.owner_cell(sw);
    let lock = env.node_lock_script(sw);
    let mut outputs = vec![(output(999 * CKB, sw.owner_lock.clone(), None), Bytes::new())];
    if let Some(d) = out {
        outputs.insert(
            0,
            (
                output(NODE_CAPACITY, lock, None),
                Bytes::copy_from_slice(&d.encode()),
            ),
        );
    }
    tx_with(vec![input(&node, 0), input(&owner, 0)], outputs, vec![])
}

/// The release transaction 1 → 2 with the Alive Cell as dep and `since = 0x40 ‖ (deadline + GRACE)`.
fn release_tx(
    env: &mut Env,
    sw: &Switch,
    out: NodeCellData,
    since: u64,
    alive_args: Option<&[u8]>,
) -> TransactionView {
    let deps: Vec<_> = alive_args.map(|a| env.alive_cell(a)).into_iter().collect();
    node_tx(
        env,
        sw,
        &enc(&sw.data(1)),
        since,
        &[(NODE_CAPACITY, enc(&out))],
        true,
        &deps,
    )
}

fn commit_tx(env: &mut Env, sw: &Switch, out: NodeCellData) -> TransactionView {
    node_tx(
        env,
        sw,
        &enc(&sw.data(0)),
        0,
        &[(NODE_CAPACITY, enc(&out))],
        true,
        &[],
    )
}

fn setup() -> (Env, Switch) {
    let mut env = Env::new();
    let sw = env.switch();
    (env, sw)
}

// --- owner path (§4.1) ---------------------------------------------------------------------------

#[test]
fn owner_can_update_deadline() {
    let (mut env, sw) = setup();
    let mut d = sw.data(1);
    d.deadline += 30 * 86_400;
    let tx = owner_tx(&mut env, &sw, Some(d));
    env.verify(tx).expect("owner postpones");
}

#[test]
fn owner_can_write_descriptor_hash() {
    let (mut env, sw) = setup();
    let mut d = sw.data(1);
    d.descriptor_hash = [0x5a; 32];
    let tx = owner_tx(&mut env, &sw, Some(d));
    env.verify(tx).expect("owner writes the descriptor hash");
}

#[test]
fn owner_can_destroy() {
    let (mut env, sw) = setup();
    let tx = owner_tx(&mut env, &sw, None);
    env.verify(tx).expect("owner destroys");
}

// --- commit 0 → 1 (§4.2) -------------------------------------------------------------------------

#[test]
fn node_commit_ok() {
    let (mut env, sw) = setup();
    let tx = commit_tx(&mut env, &sw, sw.data(1));
    env.verify(tx).expect("commit");
}

#[test]
fn node_commit_without_runner_input_rejected() {
    let (mut env, sw) = setup();
    let tx = node_tx(
        &mut env,
        &sw,
        &enc(&sw.data(0)),
        0,
        &[(NODE_CAPACITY, enc(&sw.data(1)))],
        false,
        &[],
    );
    assert_script_error(env.verify(tx), 15);
}

#[test]
fn node_commit_two_outputs_rejected() {
    let (mut env, sw) = setup();
    let out = enc(&sw.data(1));
    let tx = node_tx(
        &mut env,
        &sw,
        &enc(&sw.data(0)),
        0,
        &[(NODE_CAPACITY, out.clone()), (NODE_CAPACITY, out)],
        true,
        &[],
    );
    assert_script_error(env.verify(tx), 12);
}

#[test]
fn node_commit_zero_pubkey_rejected() {
    let (mut env, sw) = setup();
    let mut d = sw.data(1);
    d.pubkey = [0u8; 33];
    let tx = commit_tx(&mut env, &sw, d);
    assert_script_error(env.verify(tx), 20);
}

#[test]
fn node_commit_with_privkey_rejected() {
    let (mut env, sw) = setup();
    let mut d = sw.data(1);
    d.privkey = sw.privkey;
    let tx = commit_tx(&mut env, &sw, d);
    assert_script_error(env.verify(tx), 20);
}

#[test]
fn node_commit_changing_deadline_rejected() {
    let (mut env, sw) = setup();
    let mut d = sw.data(1);
    d.deadline -= 1;
    let tx = commit_tx(&mut env, &sw, d);
    assert_script_error(env.verify(tx), 11);
}

#[test]
fn node_commit_lower_capacity_rejected() {
    let (mut env, sw) = setup();
    let tx = node_tx(
        &mut env,
        &sw,
        &enc(&sw.data(0)),
        0,
        &[(NODE_CAPACITY - 1, enc(&sw.data(1)))],
        true,
        &[],
    );
    assert_script_error(env.verify(tx), 13);
}

// --- release 1 → 2 (§4.2) ------------------------------------------------------------------------

#[test]
fn node_release_ok() {
    let (mut env, sw) = setup();
    let t = sw.t;
    let tx = release_tx(
        &mut env,
        &sw,
        sw.data(2),
        release_since(sw.deadline),
        Some(&t),
    );
    env.verify(tx).expect("release");
}

#[test]
fn node_release_wrong_privkey_rejected() {
    let (mut env, sw) = setup();
    let mut d = sw.data(2);
    d.privkey = test_privkey(b"another switch");
    let t = sw.t;
    let tx = release_tx(&mut env, &sw, d, release_since(sw.deadline), Some(&t));
    assert_script_error(env.verify(tx), 21);
}

#[test]
fn node_release_early_since_rejected() {
    let (mut env, sw) = setup();
    let t = sw.t;
    let since = since_absolute_timestamp(sw.deadline + GRACE_SECONDS - 1);
    let tx = release_tx(&mut env, &sw, sw.data(2), since, Some(&t));
    assert_script_error(env.verify(tx), 22);
}

#[test]
fn node_release_block_since_rejected() {
    let (mut env, sw) = setup();
    let t = sw.t;
    // absolute block number: flags 0x00
    let since = sw.deadline + GRACE_SECONDS;
    let tx = release_tx(&mut env, &sw, sw.data(2), since, Some(&t));
    assert_script_error(env.verify(tx), 8);
}

#[test]
fn node_release_relative_timestamp_rejected() {
    let (mut env, sw) = setup();
    let t = sw.t;
    let since = 0xc000_0000_0000_0000 | (sw.deadline + GRACE_SECONDS);
    let tx = release_tx(&mut env, &sw, sw.data(2), since, Some(&t));
    assert_script_error(env.verify(tx), 8);
}

#[test]
fn node_release_without_alive_dep_rejected() {
    let (mut env, sw) = setup();
    let tx = release_tx(&mut env, &sw, sw.data(2), release_since(sw.deadline), None);
    assert_script_error(env.verify(tx), 23);
}

#[test]
fn node_release_alive_dep_wrong_args_rejected() {
    let (mut env, sw) = setup();
    let mut other = sw.t;
    other[0] ^= 1;
    let tx = release_tx(
        &mut env,
        &sw,
        sw.data(2),
        release_since(sw.deadline),
        Some(&other),
    );
    assert_script_error(env.verify(tx), 23);
}

/// The output carries a different, self-consistent key pair: the pubkey is not among the fields of error 11,
/// the release rule "pubkey unchanged and derived from privkey" fails first → **21** (DECISIONS.md, phase 3).
#[test]
fn node_release_changes_pubkey_rejected() {
    let (mut env, sw) = setup();
    let other = test_privkey(b"another switch");
    let mut d = sw.data(2);
    d.privkey = other;
    d.pubkey = pubkey_from_privkey(&other).unwrap();
    let t = sw.t;
    let tx = release_tx(&mut env, &sw, d, release_since(sw.deadline), Some(&t));
    assert_script_error(env.verify(tx), 21);
}

#[test]
fn node_release_from_state0_rejected() {
    let (mut env, sw) = setup();
    let alive = env.alive_cell(&sw.t);
    let tx = node_tx(
        &mut env,
        &sw,
        &enc(&sw.data(0)),
        release_since(sw.deadline),
        &[(NODE_CAPACITY, enc(&sw.data(2)))],
        true,
        &[alive],
    );
    assert_script_error(env.verify(tx), 24);
}

#[test]
fn node_state2_to_anything_rejected() {
    for state in [0u8, 1, 2] {
        let (mut env, sw) = setup();
        let alive = env.alive_cell(&sw.t);
        let tx = node_tx(
            &mut env,
            &sw,
            &enc(&sw.data(2)),
            release_since(sw.deadline),
            &[(NODE_CAPACITY, enc(&sw.data(state)))],
            true,
            &[alive],
        );
        assert_script_error(env.verify(tx), 24);
    }
}

// --- encodings -----------------------------------------------------------------------------------

#[test]
fn bad_args_length_rejected() {
    for len in [0usize, 32, 63, 65] {
        let (mut env, sw) = setup();
        let lock = env.node_lock_script_raw(&vec![7u8; len]);
        let node = env.cell(
            NODE_CAPACITY,
            lock,
            None,
            Bytes::copy_from_slice(&sw.data(1).encode()),
        );
        let wallet = env.runner_cell(&sw);
        let tx = tx_with(
            vec![input(&node, 0), input(&wallet, 0)],
            vec![(
                output(999 * CKB, sw.runner_lock.clone(), None),
                Bytes::new(),
            )],
            vec![],
        );
        assert_script_error(env.verify(tx), 5);
    }
}

#[test]
fn bad_data_length_rejected() {
    for len in [0usize, 138, 140] {
        let (mut env, sw) = setup();
        let mut data = enc(&sw.data(0));
        data.resize(len, 0);
        // even with the owner's input present: undecodable data fails before the owner path
        let node = env.node_cell(&sw, &data);
        let owner = env.owner_cell(&sw);
        let tx = tx_with(
            vec![input(&node, 0), input(&owner, 0)],
            vec![(output(999 * CKB, sw.owner_lock.clone(), None), Bytes::new())],
            vec![],
        );
        assert_script_error(env.verify(tx), 6);
    }
}

// --- budget and vectors --------------------------------------------------------------------------

#[test]
fn cycles_release_under_budget() {
    let (mut env, sw) = setup();
    let t = sw.t;
    let tx = release_tx(
        &mut env,
        &sw,
        sw.data(2),
        release_since(sw.deadline),
        Some(&t),
    );
    let cycles = env.verify(tx).expect("release");
    println!("release transaction cycles: {cycles}");
    assert!(
        cycles < RELEASE_CYCLE_BUDGET,
        "{cycles} cycles >= {RELEASE_CYCLE_BUDGET}"
    );
}

fn unhex(s: &str) -> Vec<u8> {
    let s = s.trim_start_matches("0x");
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

/// Re-checks `spec/vectors/identity.json` through `crt-core` (identity and job payload).
#[test]
fn vectors_identity_matches() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../spec/vectors/identity.json"
    );
    let text = std::fs::read_to_string(path).expect("spec/vectors/identity.json");
    let mut n = 0;
    for chunk in text.split("\"network_id\":").skip(1) {
        let net: u8 = chunk.split(',').next().unwrap().trim().parse().unwrap();
        let field = |k: &str| -> Vec<u8> {
            unhex(chunk.split(k).nth(1).unwrap().split('"').nth(1).unwrap())
        };
        let t: [u8; 32] = field("\"type_id\":").try_into().unwrap();
        assert_eq!(identity(net, &t).to_vec(), field("\"identity\":"));
        assert_eq!(parse_payload(&field("\"job_payload\":")), Ok(t));
        n += 1;
    }
    assert_eq!(n, 5);
}
