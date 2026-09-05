//! Transaction witness encodings for DAOWOW scripts.
//!
//! All witnesses are fixed-layout little-endian blobs (no molecule in the
//! prototype). Encoders here are host-side; decoders are no_std and strict.

use crate::encoding::EntryDataV1;
use crate::error::CoreError;

#[cfg(not(feature = "std"))]
use alloc::vec::Vec;
#[cfg(feature = "std")]
use std::vec::Vec;

pub fn read_u32(b: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]])
}

pub fn write_u32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_le_bytes());
}

fn read_bytes<'a>(b: &'a [u8], off: &mut usize, len: usize) -> Result<&'a [u8], CoreError> {
    if *off + len > b.len() {
        return Err(CoreError::Encoding);
    }
    let s = &b[*off..*off + len];
    *off += len;
    Ok(s)
}

// ---------------------------------------------------------------------------
// ShardAppendWitness — entry-shard-type OPEN update
//
//   u32 entry_count
//   entry_count * EntryDataV1 (132 B)
//   accumulator-specific section:
//     SMT: per entry: u32 absence_len + absence || u32 inclusion_len + inclusion
//     MMR: u32 old_peaks_len + old_peaks || u32 new_peaks_len + new_peaks
//     IMT: branch (1024 B)
// ---------------------------------------------------------------------------

pub struct ShardAppendWitness<'a> {
    pub entries: Vec<EntryDataV1>,
    pub blobs: Vec<&'a [u8]>, // SMT: 2 per entry; MMR: 2 total; IMT: 1 total
}

pub fn encode_shard_append_witness_smt(
    entries: &[EntryDataV1],
    certs: &[(&[u8], &[u8])], // (absence, inclusion) per entry
) -> Vec<u8> {
    let mut out = Vec::new();
    write_u32(&mut out, entries.len() as u32);
    for e in entries {
        out.extend_from_slice(&e.encode());
    }
    for (a, i) in certs {
        write_u32(&mut out, a.len() as u32);
        out.extend_from_slice(a);
        write_u32(&mut out, i.len() as u32);
        out.extend_from_slice(i);
    }
    out
}

pub fn encode_shard_append_witness_mmr(
    entries: &[EntryDataV1],
    old_peaks: &[u8],
    new_peaks: &[u8],
) -> Vec<u8> {
    let mut out = Vec::new();
    write_u32(&mut out, entries.len() as u32);
    for e in entries {
        out.extend_from_slice(&e.encode());
    }
    write_u32(&mut out, old_peaks.len() as u32);
    out.extend_from_slice(old_peaks);
    write_u32(&mut out, new_peaks.len() as u32);
    out.extend_from_slice(new_peaks);
    out
}

pub fn encode_shard_append_witness_imt(entries: &[EntryDataV1], branch: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    write_u32(&mut out, entries.len() as u32);
    for e in entries {
        out.extend_from_slice(&e.encode());
    }
    out.extend_from_slice(branch);
    out
}

pub fn decode_shard_append_witness<'a>(
    data: &'a [u8],
    accumulator_id: u8,
) -> Result<ShardAppendWitness<'a>, CoreError> {
    if data.len() < 4 {
        return Err(CoreError::Encoding);
    }
    let n = read_u32(data, 0) as usize;
    if n > 64 {
        return Err(CoreError::Encoding);
    }
    let mut off = 4usize;
    let mut entries = Vec::with_capacity(n);
    for _ in 0..n {
        let raw = read_bytes(data, &mut off, crate::encoding::ENTRY_DATA_SIZE)?;
        entries.push(EntryDataV1::decode(raw)?);
    }
    let blobs: Vec<&[u8]> = match accumulator_id {
        crate::encoding::ACC_SMT => {
            let mut v = Vec::new();
            for _ in 0..n {
                if off + 4 > data.len() {
                    return Err(CoreError::Encoding);
                }
                let l = read_u32(data, off) as usize;
                off += 4;
                v.push(read_bytes(data, &mut off, l)?);
                if off + 4 > data.len() {
                    return Err(CoreError::Encoding);
                }
                let l2 = read_u32(data, off) as usize;
                off += 4;
                v.push(read_bytes(data, &mut off, l2)?);
            }
            v
        }
        crate::encoding::ACC_MMR => {
            let mut v = Vec::new();
            for _ in 0..2 {
                if off + 4 > data.len() {
                    return Err(CoreError::Encoding);
                }
                let l = read_u32(data, off) as usize;
                off += 4;
                v.push(read_bytes(data, &mut off, l)?);
            }
            v
        }
        crate::encoding::ACC_IMT => {
            let mut v = Vec::new();
            v.push(read_bytes(data, &mut off, crate::accumulator::imt::IMT_BRANCH_BYTES)?);
            v
        }
        _ => return Err(CoreError::Encoding),
    };
    if off != data.len() {
        return Err(CoreError::Encoding);
    }
    Ok(ShardAppendWitness { entries, blobs })
}

// ---------------------------------------------------------------------------
// AggregationWitness — entry-lock aggregation path
//
//   u32 proof_len + proof (accumulator membership proof of the entry leaf)
// ---------------------------------------------------------------------------

pub fn encode_aggregation_witness(proof: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    write_u32(&mut out, proof.len() as u32);
    out.extend_from_slice(proof);
    out
}

pub fn decode_aggregation_witness(data: &[u8]) -> Result<&[u8], CoreError> {
    if data.len() < 4 {
        return Err(CoreError::Encoding);
    }
    let l = read_u32(data, 0) as usize;
    if data.len() != 4 + l {
        return Err(CoreError::Encoding);
    }
    Ok(&data[4..])
}

// ---------------------------------------------------------------------------
// SettlementWitness — settlement-type payout batch
//
//   u32 count
//   count * {
//     u8 lock_args_len, lock_args, code_hash(32), hash_type(1),
//     PayoutItem(48),
//     u32 proof_len, proof
//   }
// ---------------------------------------------------------------------------

pub struct SettlementPayout<'a> {
    pub lock_args: &'a [u8],
    pub lock_code_hash: &'a [u8],
    pub lock_hash_type: u8,
    pub item: crate::encoding::PayoutItem,
    pub proof: &'a [u8],
}

pub fn encode_settlement_witness(payouts: &[(&[u8], &[u8], u8, &crate::encoding::PayoutItem, &[u8])]) -> Vec<u8> {
    let mut out = Vec::new();
    write_u32(&mut out, payouts.len() as u32);
    for (args, code_hash, hash_type, item, proof) in payouts {
        assert!(args.len() <= 255);
        out.push(args.len() as u8);
        out.extend_from_slice(args);
        out.extend_from_slice(code_hash);
        out.push(*hash_type);
        out.extend_from_slice(&item.encode());
        write_u32(&mut out, proof.len() as u32);
        out.extend_from_slice(proof);
    }
    out
}

pub fn decode_settlement_witness(data: &[u8]) -> Result<Vec<SettlementPayout>, CoreError> {
    if data.len() < 4 {
        return Err(CoreError::Encoding);
    }
    let n = read_u32(data, 0) as usize;
    if n > 128 {
        return Err(CoreError::Encoding);
    }
    let mut off = 4usize;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        if off + 1 > data.len() {
            return Err(CoreError::Encoding);
        }
        let args_len = data[off] as usize;
        off += 1;
        let lock_args = read_bytes(data, &mut off, args_len)?;
        let lock_code_hash = read_bytes(data, &mut off, 32)?;
        let lock_hash_type = *read_bytes(data, &mut off, 1)?.first().ok_or(CoreError::Encoding)?;
        let item_raw = read_bytes(data, &mut off, crate::encoding::PAYOUT_ITEM_SIZE)?;
        let item = crate::encoding::PayoutItem::decode(item_raw)?;
        if off + 4 > data.len() {
            return Err(CoreError::Encoding);
        }
        let l = read_u32(data, off) as usize;
        off += 4;
        let proof = read_bytes(data, &mut off, l)?;
        out.push(SettlementPayout {
            lock_args,
            lock_code_hash,
            lock_hash_type,
            item,
            proof,
        });
    }
    if off != data.len() {
        return Err(CoreError::Encoding);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encoding::ACC_SMT;

    #[test]
    fn shard_append_roundtrip_smt() {
        let entries: Vec<EntryDataV1> = (0u64..3)
            .map(|i| EntryDataV1 {
                round_id: [1; 32],
                shard_id: 0,
                participant_lock_hash: [2; 32],
                ticket_count: 1,
                principal: 100,
                position_base: i,
                entry_nonce: i,
                entropy_commitment: [3; 32],
            })
            .collect();
        let certs = [(&b"abs"[..], &b"inc"[..]), (&b"a2"[..], &b"i2"[..]), (&b"a3"[..], &b"i3"[..])];
        let wire = encode_shard_append_witness_smt(&entries, &certs);
        let dec = decode_shard_append_witness(&wire, ACC_SMT).unwrap();
        assert_eq!(dec.entries.len(), 3);
        assert_eq!(dec.blobs.len(), 6);
        assert_eq!(dec.blobs[0], b"abs");
        assert_eq!(dec.blobs[5], b"i3");
    }

    #[test]
    fn aggregation_witness_roundtrip() {
        let wire = encode_aggregation_witness(b"proof-bytes");
        assert_eq!(decode_aggregation_witness(&wire).unwrap(), b"proof-bytes");
        assert!(decode_aggregation_witness(&wire[..wire.len() - 1]).is_err());
    }

    #[test]
    fn settlement_witness_roundtrip() {
        let item = crate::encoding::PayoutItem { participant_lock_hash: [9; 32], principal: 5, prize: 1 };
        let wire = encode_settlement_witness(&[(&b"args"[..], &[7u8; 32][..], 1, &item, &b"p"[..])]);
        let dec = decode_settlement_witness(&wire).unwrap();
        assert_eq!(dec.len(), 1);
        assert_eq!(dec[0].lock_args, b"args");
        assert_eq!(dec[0].lock_hash_type, 1);
        assert_eq!(dec[0].item, item);
        assert_eq!(dec[0].proof, b"p");
    }
}
