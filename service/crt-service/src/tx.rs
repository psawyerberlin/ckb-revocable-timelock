//! Hand-built molecule encodings (`csr-svc` has no builder and `ckb-types` is not used on the VM): `Script`,
//! `CellOutput` parsing and the skeleton `Transaction` (CKB `blockchain.mol`).
use alloc::vec::Vec;
use core::ops::Range;

/// `hash_type` bytes.
pub const HASH_TYPE_TYPE: u8 = 1;
pub const HASH_TYPE_DATA2: u8 = 4; // CKB molecule encoding: data 0, type 1, data1 2, data2 4
/// `dep_type` code.
pub const DEP_TYPE_CODE: u8 = 0;

fn u32_le(b: &[u8], p: usize) -> Option<usize> {
    let s = b.get(p..p + 4)?;
    Some(u32::from_le_bytes([s[0], s[1], s[2], s[3]]) as usize)
}

/// Molecule table / dynvec: total size, offsets, then the items.
fn table(fields: &[&[u8]]) -> Vec<u8> {
    let header = 4 * (1 + fields.len());
    let total = header + fields.iter().map(|f| f.len()).sum::<usize>();
    let mut v = Vec::with_capacity(total);
    v.extend_from_slice(&(total as u32).to_le_bytes());
    let mut off = header;
    for f in fields {
        v.extend_from_slice(&(off as u32).to_le_bytes());
        off += f.len();
    }
    for f in fields {
        v.extend_from_slice(f);
    }
    v
}

/// Molecule fixvec of fixed-size items (also `Bytes` with 1-byte items).
fn fixvec(count: usize, items: &[&[u8]]) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&(count as u32).to_le_bytes());
    for i in items {
        v.extend_from_slice(i);
    }
    v
}

fn bytes(b: &[u8]) -> Vec<u8> {
    fixvec(b.len(), &[b])
}

/// Molecule `Script { code_hash, hash_type, args: Bytes }`.
pub fn script(code_hash: &[u8; 32], hash_type: u8, args: &[u8]) -> Vec<u8> {
    table(&[code_hash, &[hash_type], &bytes(args)])
}

/// Parses a molecule `CellOutput { capacity: Uint64, lock: Script, type_: ScriptOpt }`; returns the capacity
/// and the byte range of the lock script. Strict: exactly three fields, offsets in order, total = length.
pub fn parse_cell_output(b: &[u8]) -> Option<(u64, Range<usize>)> {
    if u32_le(b, 0)? != b.len() {
        return None;
    }
    let (o0, o1, o2) = (u32_le(b, 4)?, u32_le(b, 8)?, u32_le(b, 12)?);
    if o0 != 16 || o1 != o0 + 8 || o2 < o1 || o2 > b.len() {
        return None;
    }
    let mut cap = [0u8; 8];
    cap.copy_from_slice(&b[o0..o1]);
    crt_host::parse_script_args(&b[o1..o2])?;
    Some((u64::from_le_bytes(cap), o1..o2))
}

/// What the service hands to `tx_skeleton_put`: one Node Cell input (with `since`), the recreated Node Cell
/// (same `CellOutput` bytes, i.e. same capacity and lock, new data), code cell deps, one empty witness.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Skeleton {
    pub input: [u8; 36],
    pub since: u64,
    /// Molecule `CellOutput` of the input, copied verbatim.
    pub output: Vec<u8>,
    pub output_data: Vec<u8>,
    /// Out points of the cell deps, all `dep_type code`, in order.
    pub cell_deps: Vec<[u8; 36]>,
}

impl Skeleton {
    /// Molecule `Transaction { raw: RawTransaction, witnesses: BytesVec }` with `version 0`, no header deps.
    pub fn to_molecule(&self) -> Vec<u8> {
        let deps: Vec<[u8; 37]> = self
            .cell_deps
            .iter()
            .map(|op| {
                let mut d = [0u8; 37];
                d[..36].copy_from_slice(op);
                d[36] = DEP_TYPE_CODE;
                d
            })
            .collect();
        let dep_refs: Vec<&[u8]> = deps.iter().map(|d| &d[..]).collect();
        let mut input = [0u8; 44];
        input[..8].copy_from_slice(&self.since.to_le_bytes());
        input[8..].copy_from_slice(&self.input);
        let raw = table(&[
            &0u32.to_le_bytes(),
            &fixvec(deps.len(), &dep_refs),
            &fixvec(0, &[]),
            &fixvec(1, &[&input]),
            &table(&[&self.output]),
            &table(&[&bytes(&self.output_data)]),
        ]);
        let witnesses = table(&[&bytes(&[])]);
        table(&[&raw, &witnesses])
    }
}

#[cfg(test)]
mod hash_type_tests {
    use super::*;

    /// The mock chain of the unit tests uses these constants on both sides, so a wrong value passes everywhere
    /// except on a real node (devnet run: `2` is `data1`, the Node Cell query found nothing and every run
    /// reported `dropped`). CKB's molecule `Script.hash_type` bytes: data 0, type 1, data1 2, data2 4.
    #[test]
    fn hash_type_bytes_match_ckb() {
        assert_eq!(HASH_TYPE_TYPE, 1);
        assert_eq!(HASH_TYPE_DATA2, 4);
        let s = script(&[0u8; 32], HASH_TYPE_DATA2, &[0xaa; 64]);
        assert_eq!(s[4 * 4 + 32], 4, "hash_type byte inside the molecule Script");
    }
}
