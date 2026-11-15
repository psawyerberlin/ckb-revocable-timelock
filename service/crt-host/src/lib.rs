//! Host bindings of the CRT service: the CSR service calls (spec/host-interface.md) and the two CKB
//! syscalls the service needs, behind a `Host` trait with a real (`Syscalls`) and a mock (`MockHost`)
//! implementation. Every wrapper returns the raw host code; buffer-out calls follow CKB's partial loading
//! (`len` holds the buffer size on entry and the full data length on return; the result is `(code, full_len)`).
#![no_std]

#[cfg(any(test, feature = "mock"))]
extern crate alloc;

#[cfg(any(test, feature = "mock"))]
mod mock;
#[cfg(any(test, feature = "mock"))]
pub use mock::MockHost;

pub const JOB_PAYLOAD: u64 = 7001;
pub const BLOCK_INFO: u64 = 7002;
pub const CHAIN_READ: u64 = 7003;
pub const CELLS_QUERY: u64 = 7004;
pub const KV_GET: u64 = 7010;
pub const KV_PUT: u64 = 7011;
pub const KV_DELETE: u64 = 7012;
pub const KV_MARK_SECRET: u64 = 7013;
pub const DELETE_ON_CONSUME: u64 = 7014;
pub const TX_SKELETON_PUT: u64 = 7030;
pub const RESULT_PUT: u64 = 7031;
pub const RANDOM_BYTES: u64 = 7050;
/// CKB `load_script` and `load_cell_data`.
pub const LOAD_SCRIPT: u64 = 2052;
pub const LOAD_CELL_DATA: u64 = 2092;
/// CKB `Source::CellDep`.
pub const SOURCE_CELL_DEP: u64 = 3;

// Return codes.
pub const OK: u64 = 0;
pub const MISSING: u64 = 1;
pub const NOT_SUPPORTED: u64 = 2;
pub const QUOTA_EXCEEDED: u64 = 10;
pub const TOO_LARGE: u64 = 11;
pub const INVALID: u64 = 12;

/// `chain_read` kinds.
pub const KIND_CELL_OUTPUT: u64 = 0;
pub const KIND_CELL_DATA: u64 = 1;
pub const KIND_HEADER: u64 = 2;
pub const KIND_TRANSACTION: u64 = 3;

/// `cells_query` script types.
pub const SCRIPT_TYPE_LOCK: u64 = 0;
pub const SCRIPT_TYPE_TYPE: u64 = 1;

/// Size of the `block_info` answer: tip number, packed epoch, median time in ms (u64 LE each).
pub const BLOCK_INFO_LEN: usize = 24;

/// Largest molecule `Script` `load_script_args` accepts.
pub const MAX_SCRIPT_LEN: usize = 512;

/// Raw RISC-V `ecall` with up to six arguments.
///
/// # Safety
/// The arguments must be valid for the syscall `n` (pointers into live memory).
#[inline(always)]
pub unsafe fn syscall(n: u64, a: [u64; 6]) -> u64 {
    #[cfg(target_arch = "riscv64")]
    let mut r0 = a[0];
    #[cfg(target_arch = "riscv64")]
    core::arch::asm!(
        "ecall",
        inout("a0") r0,
        in("a1") a[1],
        in("a2") a[2],
        in("a3") a[3],
        in("a4") a[4],
        in("a5") a[5],
        in("a7") n,
    );
    #[cfg(not(target_arch = "riscv64"))]
    {
        let _ = (n, a);
        u64::MAX
    }
    #[cfg(target_arch = "riscv64")]
    r0
}

/// Everything the state machine may ask of its environment.
pub trait Host {
    /// Job payload (same bytes as witness 0). `(code, full length)`.
    fn job_payload(&mut self, buf: &mut [u8]) -> (u64, u64);
    /// Tip number, packed epoch, median time (ms): 24 bytes LE.
    fn block_info(&mut self, out: &mut [u8; BLOCK_INFO_LEN]) -> u64;
    /// `kind` 0 cell output, 1 cell data (key = 36-byte out point), 2 header, 3 transaction (key = 32-byte hash).
    fn chain_read(&mut self, kind: u64, key: &[u8], buf: &mut [u8]) -> (u64, u64);
    /// Indexer query with a molecule `Script`; answers an `OutPointVec` (u32 LE count, 36-byte out points).
    fn cells_query(&mut self, script: &[u8], script_type: u64, buf: &mut [u8]) -> (u64, u64);
    fn kv_get(&mut self, key: &[u8], buf: &mut [u8]) -> (u64, u64);
    fn kv_put(&mut self, key: &[u8], val: &[u8]) -> u64;
    fn kv_delete(&mut self, key: &[u8]) -> u64;
    fn kv_mark_secret(&mut self, key: &[u8]) -> u64;
    fn delete_on_consume(&mut self, key: &[u8], outpoint: &[u8; 36]) -> u64;
    fn random_bytes(&mut self, buf: &mut [u8]) -> u64;
    fn tx_skeleton_put(&mut self, tx: &[u8]) -> u64;
    fn result_put(&mut self, data: &[u8]) -> u64;
    /// `load_script` parsed by hand; copies the script args into `buf` and returns `(code, args length)`.
    /// Code 0 ok, 12 malformed or larger than `MAX_SCRIPT_LEN`, otherwise the syscall's code.
    fn load_script_args(&mut self, buf: &mut [u8]) -> (u64, u64);
    /// `load_cell_data(index = 1, Source::CellDep)`: the deployment data cell (SPEC.md §5.5).
    fn load_deployment_data(&mut self, buf: &mut [u8]) -> (u64, u64);
}

/// Partial copy shared by every buffer-out call: writes `min(buf.len(), data.len() - offset)` bytes.
pub fn copy_partial(data: &[u8], buf: &mut [u8], offset: usize) -> usize {
    let rest = data.get(offset..).unwrap_or(&[]);
    let n = rest.len().min(buf.len());
    buf[..n].copy_from_slice(&rest[..n]);
    n
}

/// Parses a molecule `Script` (table: total, 3 offsets, code_hash, hash_type, args(Bytes)) and returns the
/// byte range of the args payload inside `script`.
pub fn parse_script_args(script: &[u8]) -> Option<core::ops::Range<usize>> {
    let u32_at = |p: usize| -> Option<usize> {
        let b = script.get(p..p + 4)?;
        Some(u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize)
    };
    if u32_at(0)? != script.len() || script.len() < 16 {
        return None;
    }
    let (o0, o1, o2) = (u32_at(4)?, u32_at(8)?, u32_at(12)?);
    if o0 != 16 || o1 != o0 + 32 || o2 != o1 + 1 || o2 + 4 > script.len() {
        return None;
    }
    let n = u32_at(o2)?;
    let end = (o2 + 4).checked_add(n)?;
    if end != script.len() {
        return None;
    }
    Some(o2 + 4..end)
}

/// The real host: CKB-VM syscalls.
pub struct Syscalls;

fn buf_out(no: u64, args: impl FnOnce(u64, u64) -> [u64; 6], buf: &mut [u8]) -> (u64, u64) {
    let mut len = buf.len() as u64;
    let r = unsafe { syscall(no, args(buf.as_mut_ptr() as u64, &mut len as *mut u64 as u64)) };
    (r, len)
}

/// `job_payload(addr, len_ptr, offset)`.
pub fn job_payload(buf: &mut [u8]) -> (u64, u64) {
    buf_out(JOB_PAYLOAD, |a, l| [a, l, 0, 0, 0, 0], buf)
}

/// `block_info(addr)`: 24 bytes.
pub fn block_info(out: &mut [u8; BLOCK_INFO_LEN]) -> u64 {
    unsafe { syscall(BLOCK_INFO, [out.as_mut_ptr() as u64, 0, 0, 0, 0, 0]) }
}

/// `chain_read(kind, key, addr, len_ptr, offset)`.
pub fn chain_read(kind: u64, key: &[u8], buf: &mut [u8]) -> (u64, u64) {
    buf_out(CHAIN_READ, |a, l| [kind, key.as_ptr() as u64, a, l, 0, 0], buf)
}

/// `cells_query(script, script_len, script_type, addr, len_ptr, offset)`.
pub fn cells_query(script: &[u8], script_type: u64, buf: &mut [u8]) -> (u64, u64) {
    buf_out(
        CELLS_QUERY,
        |a, l| [script.as_ptr() as u64, script.len() as u64, script_type, a, l, 0],
        buf,
    )
}

/// `kv_get(key, key_len, addr, len_ptr, offset)`.
pub fn kv_get(key: &[u8], buf: &mut [u8]) -> (u64, u64) {
    buf_out(KV_GET, |a, l| [key.as_ptr() as u64, key.len() as u64, a, l, 0, 0], buf)
}

/// `kv_put`; 0, 10 quota exceeded, 11 too large, 12 empty key.
pub fn kv_put(key: &[u8], val: &[u8]) -> u64 {
    unsafe {
        syscall(
            KV_PUT,
            [key.as_ptr() as u64, key.len() as u64, val.as_ptr() as u64, val.len() as u64, 0, 0],
        )
    }
}

/// `kv_delete`; 0 ok, 1 missing.
pub fn kv_delete(key: &[u8]) -> u64 {
    unsafe { syscall(KV_DELETE, [key.as_ptr() as u64, key.len() as u64, 0, 0, 0, 0]) }
}

/// `kv_mark_secret`; 0 ok, 1 missing.
pub fn kv_mark_secret(key: &[u8]) -> u64 {
    unsafe { syscall(KV_MARK_SECRET, [key.as_ptr() as u64, key.len() as u64, 0, 0, 0, 0]) }
}

/// `delete_on_consume(key, key_len, outpoint)` with a 36-byte out point.
pub fn delete_on_consume(key: &[u8], outpoint: &[u8; 36]) -> u64 {
    unsafe {
        syscall(
            DELETE_ON_CONSUME,
            [key.as_ptr() as u64, key.len() as u64, outpoint.as_ptr() as u64, 0, 0, 0],
        )
    }
}

/// `random_bytes(addr, len)`; 0, 11 over 1024 bytes, 12 empty.
pub fn random_bytes(buf: &mut [u8]) -> u64 {
    unsafe { syscall(RANDOM_BYTES, [buf.as_mut_ptr() as u64, buf.len() as u64, 0, 0, 0, 0]) }
}

/// `tx_skeleton_put(addr, len)`; the last call wins.
pub fn tx_skeleton_put(tx: &[u8]) -> u64 {
    unsafe { syscall(TX_SKELETON_PUT, [tx.as_ptr() as u64, tx.len() as u64, 0, 0, 0, 0]) }
}

/// `result_put(addr, len)`.
pub fn result_put(data: &[u8]) -> u64 {
    unsafe { syscall(RESULT_PUT, [data.as_ptr() as u64, data.len() as u64, 0, 0, 0, 0]) }
}

/// CKB `load_script`, then hand-parsed; see `Host::load_script_args`.
pub fn load_script_args(buf: &mut [u8]) -> (u64, u64) {
    let mut script = [0u8; MAX_SCRIPT_LEN];
    let (r, len) = buf_out(LOAD_SCRIPT, |a, l| [a, l, 0, 0, 0, 0], &mut script);
    if r != OK {
        return (r, 0);
    }
    if len as usize > MAX_SCRIPT_LEN {
        return (INVALID, 0);
    }
    match parse_script_args(&script[..len as usize]) {
        Some(range) => {
            let args = &script[range];
            let n = copy_partial(args, buf, 0);
            let _ = n;
            (OK, args.len() as u64)
        }
        None => (INVALID, 0),
    }
}

/// CKB `load_cell_data(index 1, Source::CellDep)`.
pub fn load_deployment_data(buf: &mut [u8]) -> (u64, u64) {
    buf_out(LOAD_CELL_DATA, |a, l| [a, l, 0, 1, SOURCE_CELL_DEP, 0], buf)
}

impl Host for Syscalls {
    fn job_payload(&mut self, buf: &mut [u8]) -> (u64, u64) {
        job_payload(buf)
    }
    fn block_info(&mut self, out: &mut [u8; BLOCK_INFO_LEN]) -> u64 {
        block_info(out)
    }
    fn chain_read(&mut self, kind: u64, key: &[u8], buf: &mut [u8]) -> (u64, u64) {
        chain_read(kind, key, buf)
    }
    fn cells_query(&mut self, script: &[u8], script_type: u64, buf: &mut [u8]) -> (u64, u64) {
        cells_query(script, script_type, buf)
    }
    fn kv_get(&mut self, key: &[u8], buf: &mut [u8]) -> (u64, u64) {
        kv_get(key, buf)
    }
    fn kv_put(&mut self, key: &[u8], val: &[u8]) -> u64 {
        kv_put(key, val)
    }
    fn kv_delete(&mut self, key: &[u8]) -> u64 {
        kv_delete(key)
    }
    fn kv_mark_secret(&mut self, key: &[u8]) -> u64 {
        kv_mark_secret(key)
    }
    fn delete_on_consume(&mut self, key: &[u8], outpoint: &[u8; 36]) -> u64 {
        delete_on_consume(key, outpoint)
    }
    fn random_bytes(&mut self, buf: &mut [u8]) -> u64 {
        random_bytes(buf)
    }
    fn tx_skeleton_put(&mut self, tx: &[u8]) -> u64 {
        tx_skeleton_put(tx)
    }
    fn result_put(&mut self, data: &[u8]) -> u64 {
        result_put(data)
    }
    fn load_script_args(&mut self, buf: &mut [u8]) -> (u64, u64) {
        load_script_args(buf)
    }
    fn load_deployment_data(&mut self, buf: &mut [u8]) -> (u64, u64) {
        load_deployment_data(buf)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec::Vec;

    fn script(args: &[u8]) -> Vec<u8> {
        let total = 16 + 32 + 1 + 4 + args.len();
        let mut v = Vec::new();
        v.extend_from_slice(&(total as u32).to_le_bytes());
        for o in [16u32, 48, 49] {
            v.extend_from_slice(&o.to_le_bytes());
        }
        v.extend_from_slice(&[7u8; 32]);
        v.push(2);
        v.extend_from_slice(&(args.len() as u32).to_le_bytes());
        v.extend_from_slice(args);
        v
    }

    #[test]
    fn parses_script_args() {
        let s = script(&[1, 2, 3]);
        assert_eq!(&s[parse_script_args(&s).unwrap()], &[1, 2, 3]);
        assert!(parse_script_args(&s[..s.len() - 1]).is_none());
        assert!(parse_script_args(&[]).is_none());
    }

    #[test]
    fn mock_load_script_args_and_partial() {
        let mut m = MockHost::default();
        m.script = script(&[9u8; 32]);
        let mut b = [0u8; 8];
        assert_eq!(m.load_script_args(&mut b), (OK, 32));
        assert_eq!(b, [9u8; 8]);
        m.script = alloc::vec![1, 2];
        assert_eq!(m.load_script_args(&mut b).0, INVALID);
    }

    #[test]
    fn mock_kv_semantics() {
        let mut m = MockHost::default();
        let mut b = [0u8; 4];
        assert_eq!(m.kv_get(b"k", &mut b).0, MISSING);
        assert_eq!(m.kv_put(b"", b"v"), INVALID);
        assert_eq!(m.kv_put(b"k", b"vvvvvv"), OK);
        assert_eq!(m.kv_get(b"k", &mut b), (OK, 6));
        assert_eq!(m.kv_mark_secret(b"k"), OK);
        assert_eq!(m.kv_mark_secret(b"x"), MISSING);
        assert_eq!(m.kv_delete(b"k"), OK);
        assert_eq!(m.kv_delete(b"k"), MISSING);
    }

    #[test]
    fn mock_random_is_deterministic_and_scriptable() {
        let mut a = MockHost::default();
        let mut b = MockHost::default();
        let (mut x, mut y) = ([0u8; 32], [0u8; 32]);
        a.random_bytes(&mut x);
        b.random_bytes(&mut y);
        assert_eq!(x, y);
        a.random_bytes(&mut y);
        assert_ne!(x, y);
        a.random_queue.push_back(alloc::vec![0u8; 32]);
        a.random_bytes(&mut x);
        assert_eq!(x, [0u8; 32]);
        assert_eq!(a.random_calls, 3);
    }
}
