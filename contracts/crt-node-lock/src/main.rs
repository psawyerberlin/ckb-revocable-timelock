//! `crt-node-lock`, args = `T (32) ‖ R (32)`, `hash_type data2`. Implements `SPEC.md` §4 rule by rule, with the
//! error codes of §4.3 (phase 3 of `aiworker/01-crt-contracts.md`).
//!
//! Rule order (it determines the error code):
//!
//! 1. args are exactly 64 bytes, else 5;
//! 2. the data of every input of the group is a valid `NodeCellData`, else 6;
//! 3. owner path (§4.1): if, for every input of the group, some transaction input has
//!    `lock_hash == owner_lock_hash` of that input's data, the script succeeds;
//! 4. node path (§4.2): an input with `lock_hash == R` (15); exactly one output with this lock script and exactly
//!    one input in the group (12); the output has no type script (14); output data valid (6); capacity not lower (13); `version`, `deadline`,
//!    `owner_lock_hash`, `descriptor_hash` unchanged (11); then commit 0 → 1 (20) or release 1 → 2
//!    (21, then 8 / 22, then 23); any other transition 24.
#![no_std]
#![no_main]

use ckb_std::ckb_constants::{CellField, InputField, Source};
use ckb_std::error::SysError;
use ckb_std::syscalls;
use crt_core::{
    pubkey_from_privkey, since_is_absolute_timestamp, NodeCellData, GRACE_SECONDS,
    NODE_CELL_DATA_LEN, TYPE_ID_CODE_HASH,
};

ckb_std::entry!(program_entry);
ckb_std::default_alloc!();

// SPEC.md §4.3; 1–4 are syscall failures (see `sys`).
const ERR_ARGS: i8 = 5;
const ERR_DATA: i8 = 6;
const ERR_SINCE_FORM: i8 = 8;
const ERR_CHANGED: i8 = 11;
const ERR_OUTPUT_COUNT: i8 = 12;
const ERR_CAPACITY: i8 = 13;
const ERR_OUTPUT_TYPE: i8 = 14;
const ERR_NO_RUNNER: i8 = 15;
const ERR_COMMIT: i8 = 20;
const ERR_PRIVKEY: i8 = 21;
const ERR_SINCE_EARLY: i8 = 22;
const ERR_NO_ALIVE_DEP: i8 = 23;
const ERR_TRANSITION: i8 = 24;

/// `hash_type = type` in a molecule `Script`.
const HASH_TYPE_TYPE: u8 = 1;

fn program_entry() -> i8 {
    match run() {
        Ok(()) => 0,
        Err(code) => code,
    }
}

fn sys(e: SysError) -> i8 {
    match e {
        SysError::IndexOutOfBound => 1,
        SysError::ItemMissing => 2,
        SysError::LengthNotEnough(_) => 3,
        _ => 4,
    }
}

fn read_u32(b: &[u8], at: usize) -> Option<usize> {
    Some(u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?) as usize)
}

/// Splits a molecule-encoded `Script` (table of `code_hash: Byte32`, `hash_type: byte`, `args: Bytes`) into its
/// three fields. `None` unless the encoding is exactly that table.
fn parse_script(s: &[u8]) -> Option<(&[u8], u8, &[u8])> {
    if read_u32(s, 0)? != s.len() {
        return None;
    }
    let (o0, o1, o2) = (read_u32(s, 4)?, read_u32(s, 8)?, read_u32(s, 12)?);
    if o0 != 16 || o1 != o0 + 32 || o2 != o1 + 1 {
        return None;
    }
    let len = read_u32(s, o2)?;
    if o2.checked_add(4)?.checked_add(len)? != s.len() {
        return None;
    }
    Some((s.get(o0..o1)?, *s.get(o1)?, s.get(o2 + 4..)?))
}

/// The data of a cell as `NodeCellData`; error 6 for anything but a valid 139-byte layout.
fn load_node_data(index: usize, source: Source) -> Result<NodeCellData, i8> {
    let mut buf = [0u8; NODE_CELL_DATA_LEN];
    let n = match syscalls::load_cell_data(&mut buf, 0, index, source) {
        Ok(n) => n,
        Err(SysError::LengthNotEnough(_)) => return Err(ERR_DATA),
        Err(e) => return Err(sys(e)),
    };
    NodeCellData::decode(&buf[..n]).map_err(|_| ERR_DATA)
}

fn load_capacity(index: usize, source: Source) -> Result<u64, i8> {
    let mut buf = [0u8; 8];
    let n = syscalls::load_cell_by_field(&mut buf, 0, index, source, CellField::Capacity)
        .map_err(sys)?;
    if n != 8 {
        return Err(4);
    }
    Ok(u64::from_le_bytes(buf))
}

/// Whether any input of the transaction has lock hash `hash`.
fn has_input_with_lock_hash(hash: &[u8]) -> Result<bool, i8> {
    let mut buf = [0u8; 32];
    for i in 0.. {
        match syscalls::load_cell_by_field(&mut buf, 0, i, Source::Input, CellField::LockHash) {
            Ok(32) if buf[..] == *hash => return Ok(true),
            Ok(_) => {}
            Err(SysError::IndexOutOfBound) => break,
            Err(e) => return Err(sys(e)),
        }
    }
    Ok(false)
}

fn run() -> Result<(), i8> {
    // args = T ‖ R (rule 1, error 5)
    let mut sbuf = [0u8; 256];
    let script = match syscalls::load_script(&mut sbuf, 0) {
        Ok(n) => &sbuf[..n],
        Err(SysError::LengthNotEnough(_)) => return Err(ERR_ARGS),
        Err(e) => return Err(sys(e)),
    };
    let (_, _, args) = parse_script(script).ok_or(ERR_ARGS)?;
    if args.len() != 64 {
        return Err(ERR_ARGS);
    }
    let (t, r) = args.split_at(32);

    // Every input of the group: valid data (error 6), and the owner path (§4.1) per input.
    let mut group_inputs = 0usize;
    let mut all_owner = true;
    loop {
        match syscalls::load_cell_by_field(
            &mut [0u8; 8],
            0,
            group_inputs,
            Source::GroupInput,
            CellField::Capacity,
        ) {
            Ok(_) => {}
            Err(SysError::IndexOutOfBound) => break,
            Err(e) => return Err(sys(e)),
        }
        let data = load_node_data(group_inputs, Source::GroupInput)?;
        if all_owner && !has_input_with_lock_hash(&data.owner_lock_hash)? {
            all_owner = false;
        }
        group_inputs += 1;
    }
    if group_inputs == 0 {
        // a lock group always has at least one input; anything else is a syscall anomaly
        return Err(sys(SysError::IndexOutOfBound));
    }
    if all_owner {
        return Ok(());
    }

    // Node path (§4.2). Runner wallet input (error 15).
    if !has_input_with_lock_hash(r)? {
        return Err(ERR_NO_RUNNER);
    }
    // Exactly one output with this lock script, for exactly one input in the group (error 12).
    let mut own_hash = [0u8; 32];
    if syscalls::load_script_hash(&mut own_hash, 0).map_err(sys)? != 32 {
        return Err(4);
    }
    let mut out_index = None;
    let mut out_count = 0usize;
    let mut hash = [0u8; 32];
    for i in 0.. {
        match syscalls::load_cell_by_field(&mut hash, 0, i, Source::Output, CellField::LockHash) {
            Ok(32) if hash == own_hash => {
                out_count += 1;
                out_index = Some(i);
            }
            Ok(_) => {}
            Err(SysError::IndexOutOfBound) => break,
            Err(e) => return Err(sys(e)),
        }
    }
    let out_index = match out_index {
        Some(i) if out_count == 1 && group_inputs == 1 => i,
        _ => return Err(ERR_OUTPUT_COUNT),
    };

    // The Node Cell has no type script (SPEC §3.2): a runner must not attach one, or it could make the cell
    // impossible for the owner to spend (error 14).
    match syscalls::load_cell_by_field(&mut [0u8; 1], 0, out_index, Source::Output, CellField::Type) {
        Err(SysError::ItemMissing) => {}
        Ok(_) | Err(SysError::LengthNotEnough(_)) => return Err(ERR_OUTPUT_TYPE),
        Err(e) => return Err(sys(e)),
    }

    let old = load_node_data(0, Source::GroupInput)?;
    let new = load_node_data(out_index, Source::Output)?;
    if load_capacity(out_index, Source::Output)? < load_capacity(0, Source::GroupInput)? {
        return Err(ERR_CAPACITY);
    }
    if new.version != old.version
        || new.deadline != old.deadline
        || new.owner_lock_hash != old.owner_lock_hash
        || new.descriptor_hash != old.descriptor_hash
    {
        return Err(ERR_CHANGED);
    }

    match (old.state, new.state) {
        (0, 1) => commit(&old, &new),
        (1, 2) => release(&old, &new, t),
        _ => Err(ERR_TRANSITION),
    }
}

/// 0 → 1: `in.pubkey` all zero; `out.pubkey` prefix 02/03 and not all zero; `out.privkey` all zero (error 20).
fn commit(old: &NodeCellData, new: &NodeCellData) -> Result<(), i8> {
    let in_pubkey_zero = old.pubkey.iter().all(|b| *b == 0);
    let out_prefix_ok = new.pubkey[0] == 0x02 || new.pubkey[0] == 0x03;
    let out_pubkey_nonzero = new.pubkey.iter().any(|b| *b != 0);
    let out_privkey_zero = new.privkey.iter().all(|b| *b == 0);
    if in_pubkey_zero && out_prefix_ok && out_pubkey_nonzero && out_privkey_zero {
        Ok(())
    } else {
        Err(ERR_COMMIT)
    }
}

/// 1 → 2: pubkey kept and derived from `out.privkey` (21); `since` absolute timestamp (8) and
/// `≥ deadline + GRACE` (22); a cell dep with the type-id script, args `T` (23).
fn release(old: &NodeCellData, new: &NodeCellData, t: &[u8]) -> Result<(), i8> {
    if new.pubkey != old.pubkey {
        return Err(ERR_PRIVKEY);
    }
    match pubkey_from_privkey(&new.privkey) {
        Ok(p) if p == old.pubkey => {}
        _ => return Err(ERR_PRIVKEY),
    }

    let mut since = [0u8; 8];
    if syscalls::load_input_by_field(&mut since, 0, 0, Source::GroupInput, InputField::Since)
        .map_err(sys)?
        != 8
    {
        return Err(4);
    }
    let seconds = since_is_absolute_timestamp(u64::from_le_bytes(since)).ok_or(ERR_SINCE_FORM)?;
    // `checked_add`: a deadline so large that `deadline + GRACE` overflows can never be reached
    match old.deadline.checked_add(GRACE_SECONDS) {
        Some(earliest) if seconds >= earliest => {}
        _ => return Err(ERR_SINCE_EARLY),
    }

    // Alive Cell dep: type script = type-id (`hash_type type`) with args T.
    let mut buf = [0u8; 128];
    for i in 0.. {
        match syscalls::load_cell_by_field(&mut buf, 0, i, Source::CellDep, CellField::Type) {
            Ok(n) => {
                if let Some((code_hash, hash_type, args)) = parse_script(&buf[..n]) {
                    if code_hash == TYPE_ID_CODE_HASH && hash_type == HASH_TYPE_TYPE && args == t {
                        return Ok(());
                    }
                }
            }
            // no type script, or one too large to have 32-byte args: not the Alive Cell
            Err(SysError::ItemMissing) | Err(SysError::LengthNotEnough(_)) => {}
            Err(SysError::IndexOutOfBound) => break,
            Err(e) => return Err(sys(e)),
        }
    }
    Err(ERR_NO_ALIVE_DEP)
}
