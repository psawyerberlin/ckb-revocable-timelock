//! `crt-core`: the pure, I/O-free library shared by `crt-node-lock`, the CRT service and the tests.
//! Normative: `SPEC.md` §2, §3.1–3.2, §4.
#![no_std]
#![deny(unsafe_code)]

use blake2b_ref::Blake2bBuilder;
use k256::elliptic_curve::sec1::{FromEncodedPoint, ToEncodedPoint};
use k256::{AffinePoint, EncodedPoint, NonZeroScalar};

pub const PREFIX_CELL: &[u8] = b"CRT/v1/cell";
pub const PREFIX_SHARE: &[u8] = b"CRT/v1/share";
pub const PREFIX_DESCRIPTOR: &[u8] = b"CRT/v1/descriptor";
pub const GRACE_SECONDS: u64 = 86_400;
pub const PAYLOAD_MAGIC: &[u8; 4] = b"CRTS";
pub const PAYLOAD_VERSION: u8 = 1;
pub const ALIVE_CELL_DATA: [u8; 4] = [0x43, 0x52, 0x54, 0x01];
pub const NODE_CELL_DATA_LEN: usize = 139;
/// Code hash of the CKB type-id script (`"TYPE_ID"`, right-aligned); `hash_type` is `type`.
pub const TYPE_ID_CODE_HASH: [u8; 32] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x54, 0x59, 0x50, 0x45, 0x5f,
    0x49, 0x44,
]; // ...545950455f4944

const SINCE_ABS_TS: u64 = 0x4000_0000_0000_0000;
const SINCE_FLAGS_MASK: u64 = 0xff00_0000_0000_0000;
const SINCE_VALUE_MASK: u64 = 0x00ff_ffff_ffff_ffff;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoreError {
    /// Data does not parse (length, version, state).
    Data,
    /// Payload does not parse.
    Payload,
    /// Invalid secp256k1 key.
    Key,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeCellData {
    pub version: u8,
    pub state: u8,
    pub deadline: u64,
    pub owner_lock_hash: [u8; 32],
    pub descriptor_hash: [u8; 32],
    pub pubkey: [u8; 33],
    pub privkey: [u8; 32],
}

impl NodeCellData {
    pub fn decode(data: &[u8]) -> Result<Self, CoreError> {
        if data.len() != NODE_CELL_DATA_LEN || data[0] != 1 || data[1] > 2 {
            return Err(CoreError::Data);
        }
        let mut deadline = [0u8; 8];
        deadline.copy_from_slice(&data[2..10]);
        let mut s = Self {
            version: data[0],
            state: data[1],
            deadline: u64::from_le_bytes(deadline),
            owner_lock_hash: [0; 32],
            descriptor_hash: [0; 32],
            pubkey: [0; 33],
            privkey: [0; 32],
        };
        s.owner_lock_hash.copy_from_slice(&data[10..42]);
        s.descriptor_hash.copy_from_slice(&data[42..74]);
        s.pubkey.copy_from_slice(&data[74..107]);
        s.privkey.copy_from_slice(&data[107..139]);
        Ok(s)
    }

    pub fn encode(&self) -> [u8; NODE_CELL_DATA_LEN] {
        let mut out = [0u8; NODE_CELL_DATA_LEN];
        out[0] = self.version;
        out[1] = self.state;
        out[2..10].copy_from_slice(&self.deadline.to_le_bytes());
        out[10..42].copy_from_slice(&self.owner_lock_hash);
        out[42..74].copy_from_slice(&self.descriptor_hash);
        out[74..107].copy_from_slice(&self.pubkey);
        out[107..139].copy_from_slice(&self.privkey);
        out
    }
}

/// blake2b-256 with the CKB personalization `ckb-default-hash`.
pub fn ckb_blake2b(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Blake2bBuilder::new(32).personal(b"ckb-default-hash").build();
    for p in parts {
        h.update(p);
    }
    let mut out = [0u8; 32];
    h.finalize(&mut out);
    out
}

/// `blake2b256(PREFIX_CELL ‖ network_id ‖ T)`.
pub fn identity(network_id: u8, type_id: &[u8; 32]) -> [u8; 32] {
    ckb_blake2b(&[PREFIX_CELL, &[network_id], type_id])
}

/// `"CRTS" ‖ 1 ‖ T` → `T`.
pub fn parse_payload(payload: &[u8]) -> Result<[u8; 32], CoreError> {
    if payload.len() != 37 || &payload[..4] != PAYLOAD_MAGIC || payload[4] != PAYLOAD_VERSION {
        return Err(CoreError::Payload);
    }
    let mut t = [0u8; 32];
    t.copy_from_slice(&payload[5..]);
    Ok(t)
}

/// Compressed public key of a secret scalar; `Err` for 0 and values ≥ n.
pub fn pubkey_from_privkey(d: &[u8; 32]) -> Result<[u8; 33], CoreError> {
    let sk = NonZeroScalar::try_from(&d[..]).map_err(|_| CoreError::Key)?;
    let pk = k256::PublicKey::from_secret_scalar(&sk);
    let enc = pk.as_affine().to_encoded_point(true);
    let mut out = [0u8; 33];
    out.copy_from_slice(enc.as_bytes());
    Ok(out)
}

/// Prefix 02/03 and a point on the curve.
pub fn is_valid_compressed_pubkey(p: &[u8; 33]) -> bool {
    if p[0] != 2 && p[0] != 3 {
        return false;
    }
    match EncodedPoint::from_bytes(p) {
        Ok(ep) => bool::from(AffinePoint::from_encoded_point(&ep).is_some()),
        Err(_) => false,
    }
}

/// CKB RFC 17: absolute (bit 63 = 0), timestamp metric (bits 62–61 = 10), value in the low 56 bits.
pub fn since_absolute_timestamp(seconds: u64) -> u64 {
    SINCE_ABS_TS | seconds
}

/// `Some(seconds)` iff the flags byte is exactly `0x40` (absolute, timestamp).
pub fn since_is_absolute_timestamp(since: u64) -> Option<u64> {
    if since & SINCE_FLAGS_MASK == SINCE_ABS_TS {
        Some(since & SINCE_VALUE_MASK)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unhex(s: &str) -> std::vec::Vec<u8> {
        let s = s.trim_start_matches("0x");
        (0..s.len() / 2).map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap()).collect()
    }
    extern crate std;

    #[test]
    fn node_cell_roundtrip() {
        let d = NodeCellData {
            version: 1,
            state: 1,
            deadline: 0x0102030405060708,
            owner_lock_hash: [7; 32],
            descriptor_hash: [8; 32],
            pubkey: [2; 33],
            privkey: [0; 32],
        };
        let e = d.encode();
        assert_eq!(e.len(), 139);
        assert_eq!(&e[2..10], &[8, 7, 6, 5, 4, 3, 2, 1]);
        assert_eq!(NodeCellData::decode(&e).unwrap(), d);
        assert_eq!(NodeCellData::decode(&e[..138]), Err(CoreError::Data));
        let mut b = e;
        b[0] = 2;
        assert_eq!(NodeCellData::decode(&b), Err(CoreError::Data));
        let mut b = e;
        b[1] = 3;
        assert_eq!(NodeCellData::decode(&b), Err(CoreError::Data));
    }

    #[test]
    fn type_id_constant() {
        assert_eq!(&TYPE_ID_CODE_HASH[25..32], b"TYPE_ID");
    }

    #[test]
    fn payload() {
        let mut p = [0u8; 37];
        p[..4].copy_from_slice(b"CRTS");
        p[4] = 1;
        p[5..].copy_from_slice(&[9; 32]);
        assert_eq!(parse_payload(&p), Ok([9; 32]));
        p[4] = 2;
        assert!(parse_payload(&p).is_err());
        assert!(parse_payload(&p[..36]).is_err());
    }

    #[test]
    fn identity_vectors() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../spec/vectors/identity.json");
        let text = std::fs::read_to_string(path).unwrap();
        let mut n = 0;
        for chunk in text.split("\"network_id\":").skip(1) {
            let net: u8 = chunk.split(',').next().unwrap().trim().parse().unwrap();
            let field = |k: &str| -> std::vec::Vec<u8> {
                let rest = chunk.split(k).nth(1).unwrap();
                let q = rest.split('"').nth(1).unwrap();
                unhex(q)
            };
            let t: [u8; 32] = field("\"type_id\":").try_into().unwrap();
            let want = field("\"identity\":");
            assert_eq!(identity(net, &t).as_slice(), want.as_slice());
            let payload = field("\"job_payload\":");
            assert_eq!(parse_payload(&payload), Ok(t));
            n += 1;
        }
        assert_eq!(n, 5);
    }

    #[test]
    fn since_encoding() {
        assert_eq!(since_absolute_timestamp(1000), 0x4000_0000_0000_03e8);
        assert_eq!(since_is_absolute_timestamp(0x4000_0000_0000_03e8), Some(1000));
        assert_eq!(since_is_absolute_timestamp(1000), None); // absolute block number
        assert_eq!(since_is_absolute_timestamp(0x2000_0000_0000_0001), None); // absolute epoch
        assert_eq!(since_is_absolute_timestamp(0xc000_0000_0000_0001), None); // relative timestamp
        assert_eq!(since_is_absolute_timestamp(0x8000_0000_0000_0001), None); // relative block
        assert_eq!(since_is_absolute_timestamp(0x4100_0000_0000_0001), None); // reserved bits
    }

    #[test]
    fn pubkey_of_one_is_generator() {
        let mut d = [0u8; 32];
        d[31] = 1;
        let p = pubkey_from_privkey(&d).unwrap();
        assert_eq!(
            p.as_slice(),
            unhex("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798").as_slice()
        );
        assert!(is_valid_compressed_pubkey(&p));
    }

    #[test]
    fn rejects_zero_and_n() {
        assert_eq!(pubkey_from_privkey(&[0; 32]), Err(CoreError::Key));
        let n: [u8; 32] = unhex("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141").try_into().unwrap();
        assert_eq!(pubkey_from_privkey(&n), Err(CoreError::Key));
        assert_eq!(pubkey_from_privkey(&[0xff; 32]), Err(CoreError::Key));
        assert!(!is_valid_compressed_pubkey(&[0; 33]));
        let mut bad = [0u8; 33];
        bad[0] = 2; // x = 0 is not on the curve
        assert!(!is_valid_compressed_pubkey(&bad));
        bad[0] = 4;
        assert!(!is_valid_compressed_pubkey(&bad));
    }
}
