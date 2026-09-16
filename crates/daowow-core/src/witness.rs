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
            alloc::vec![read_bytes(
                data,
                &mut off,
                crate::accumulator::imt::IMT_BRANCH_BYTES
            )?]
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

/// Membership proof for an absolute transaction input index. Record order is
/// entry nonce order, which the contract must check against actual input cells.
#[derive(Debug, PartialEq, Eq)]
pub struct LedgerInputProof<'a> {
    pub input_index: u32,
    pub proof: &'a [u8],
}

/// Encode version 2, count, then (absolute index, proof length, proof) records.
pub fn encode_ledger_witness(inputs: &[LedgerInputProof<'_>]) -> Result<Vec<u8>, CoreError> {
    if inputs.is_empty() || inputs.len() > crate::lifecycle::MAX_BATCH_ENTRIES {
        return Err(CoreError::Encoding);
    }
    let mut out = Vec::new();
    out.push(2);
    write_u32(
        &mut out,
        u32::try_from(inputs.len()).map_err(|_| CoreError::Overflow)?,
    );
    for (i, input) in inputs.iter().enumerate() {
        if inputs[..i]
            .iter()
            .any(|prior| prior.input_index == input.input_index)
        {
            return Err(CoreError::Encoding);
        }
        let length = u32::try_from(input.proof.len()).map_err(|_| CoreError::Overflow)?;
        write_u32(&mut out, input.input_index);
        write_u32(&mut out, length);
        out.extend_from_slice(input.proof);
    }
    Ok(out)
}

/// Decode bounded, distinct indices. Empty proof bytes are structurally legal;
/// membership validity depends on the configured accumulator verifier.
pub fn decode_ledger_witness(data: &[u8]) -> Result<Vec<LedgerInputProof<'_>>, CoreError> {
    fn take<'a>(data: &'a [u8], offset: &mut usize, len: usize) -> Result<&'a [u8], CoreError> {
        let end = offset.checked_add(len).ok_or(CoreError::Encoding)?;
        let bytes = data.get(*offset..end).ok_or(CoreError::Encoding)?;
        *offset = end;
        Ok(bytes)
    }
    fn word(data: &[u8], offset: &mut usize) -> Result<u32, CoreError> {
        Ok(u32::from_le_bytes(
            take(data, offset, 4)?
                .try_into()
                .map_err(|_| CoreError::Encoding)?,
        ))
    }
    let mut offset = 0;
    if take(data, &mut offset, 1)? != [2] {
        return Err(CoreError::Encoding);
    }
    let count = usize::try_from(word(data, &mut offset)?).map_err(|_| CoreError::Encoding)?;
    if count == 0 || count > crate::lifecycle::MAX_BATCH_ENTRIES {
        return Err(CoreError::Encoding);
    }
    let mut out: Vec<LedgerInputProof<'_>> = Vec::with_capacity(count);
    for _ in 0..count {
        let input_index = word(data, &mut offset)?;
        if out.iter().any(|prior| prior.input_index == input_index) {
            return Err(CoreError::Encoding);
        }
        let len = usize::try_from(word(data, &mut offset)?).map_err(|_| CoreError::Encoding)?;
        let proof = take(data, &mut offset, len)?;
        out.push(LedgerInputProof { input_index, proof });
    }
    if offset != data.len() {
        return Err(CoreError::Encoding);
    }
    Ok(out)
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

pub type SettlementWitnessPayout<'args, 'code_hash, 'item, 'proof> = (
    &'args [u8],
    &'code_hash [u8],
    u8,
    &'item crate::encoding::PayoutItem,
    &'proof [u8],
);

pub fn encode_settlement_witness(payouts: &[SettlementWitnessPayout<'_, '_, '_, '_>]) -> Vec<u8> {
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

pub fn decode_settlement_witness(data: &[u8]) -> Result<Vec<SettlementPayout<'_>>, CoreError> {
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
        let lock_hash_type = *read_bytes(data, &mut off, 1)?
            .first()
            .ok_or(CoreError::Encoding)?;
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

// ---------------------------------------------------------------------------
// Redemption witness: claims redeem ticket prizes from one funding cell.
// Distinguished from the payout witness by a leading 0xFF (a payout witness
// begins with a u32 count of at most 128, so its first byte is never 0xFF).
// ---------------------------------------------------------------------------

pub const REDEMPTION_WITNESS_TAG: u8 = 0xFF;
pub const MAX_REDEMPTION_ITEMS: usize = 32;

/// One claim's redemption: which input is the claim, which output is paid,
/// which prize leaf is claimed and for how much, with the funding-side MMR
/// membership proof and the claim-side paid-set absence proof.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RedemptionItem<'a> {
    pub claim_input_index: u32,
    pub payment_output_index: u32,
    pub prize_index: u64,
    pub amount: u64,
    pub mmr_proof: &'a [u8],
    pub absence_proof: &'a [u8],
}

pub fn is_redemption_witness(data: &[u8]) -> bool {
    data.first() == Some(&REDEMPTION_WITNESS_TAG)
}

pub fn encode_redemption_witness(items: &[RedemptionItem<'_>]) -> Result<Vec<u8>, CoreError> {
    use crate::accumulator::MAX_PROOF_BYTES;
    if items.is_empty() || items.len() > MAX_REDEMPTION_ITEMS {
        return Err(CoreError::Encoding);
    }
    let mut out = Vec::new();
    out.push(REDEMPTION_WITNESS_TAG);
    write_u32(&mut out, items.len() as u32);
    for item in items {
        if item.mmr_proof.len() > MAX_PROOF_BYTES || item.absence_proof.len() > MAX_PROOF_BYTES {
            return Err(CoreError::Encoding);
        }
        write_u32(&mut out, item.claim_input_index);
        write_u32(&mut out, item.payment_output_index);
        out.extend_from_slice(&item.prize_index.to_le_bytes());
        out.extend_from_slice(&item.amount.to_le_bytes());
        write_u32(&mut out, item.mmr_proof.len() as u32);
        out.extend_from_slice(item.mmr_proof);
        write_u32(&mut out, item.absence_proof.len() as u32);
        out.extend_from_slice(item.absence_proof);
    }
    Ok(out)
}

pub fn decode_redemption_witness(data: &[u8]) -> Result<Vec<RedemptionItem<'_>>, CoreError> {
    use crate::accumulator::MAX_PROOF_BYTES;
    if data.len() < 5 || data[0] != REDEMPTION_WITNESS_TAG {
        return Err(CoreError::Encoding);
    }
    let n = read_u32(data, 1) as usize;
    if n == 0 || n > MAX_REDEMPTION_ITEMS {
        return Err(CoreError::Encoding);
    }
    let mut off = 5usize;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        let head = read_bytes(data, &mut off, 24)?;
        let claim_input_index = read_u32(head, 0);
        let payment_output_index = read_u32(head, 4);
        let prize_index = crate::encoding::read_u64(head, 8);
        let amount = crate::encoding::read_u64(head, 16);
        let mmr_len = read_u32(read_bytes(data, &mut off, 4)?, 0) as usize;
        if mmr_len > MAX_PROOF_BYTES {
            return Err(CoreError::Encoding);
        }
        let mmr_proof = read_bytes(data, &mut off, mmr_len)?;
        let abs_len = read_u32(read_bytes(data, &mut off, 4)?, 0) as usize;
        if abs_len > MAX_PROOF_BYTES {
            return Err(CoreError::Encoding);
        }
        let absence_proof = read_bytes(data, &mut off, abs_len)?;
        out.push(RedemptionItem {
            claim_input_index,
            payment_output_index,
            prize_index,
            amount,
            mmr_proof,
            absence_proof,
        });
    }
    if off != data.len() {
        return Err(CoreError::Encoding);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {

    #[test]
    fn redemption_witness_round_trips_and_is_strict() {
        let items = [
            RedemptionItem {
                claim_input_index: 1,
                payment_output_index: 2,
                prize_index: 0,
                amount: 40,
                mmr_proof: &[1, 2, 3],
                absence_proof: &[4, 5],
            },
            RedemptionItem {
                claim_input_index: 3,
                payment_output_index: 4,
                prize_index: 2,
                amount: 7,
                mmr_proof: &[9],
                absence_proof: &[8, 8, 8, 8],
            },
        ];
        let wire = encode_redemption_witness(&items).unwrap();
        assert_eq!(wire[0], REDEMPTION_WITNESS_TAG);
        assert!(is_redemption_witness(&wire));
        assert!(!is_redemption_witness(&encode_settlement_witness(&[])));
        let decoded = decode_redemption_witness(&wire).unwrap();
        assert_eq!(decoded.len(), 2);
        assert_eq!(decoded[1].amount, 7);
        assert_eq!(decoded[1].absence_proof, &[8, 8, 8, 8]);
        assert_eq!(decoded[0].claim_input_index, 1);
        assert_eq!(decoded[0].payment_output_index, 2);
        assert!(decode_redemption_witness(&wire[..wire.len() - 1]).is_err());
        let mut trailing = wire.clone();
        trailing.push(0);
        assert!(decode_redemption_witness(&trailing).is_err());
        assert!(decode_redemption_witness(&[]).is_err());
        assert!(encode_redemption_witness(&[]).is_err());
        let too_many = vec![items[0]; MAX_REDEMPTION_ITEMS + 1];
        assert!(encode_redemption_witness(&too_many).is_err());
        let big = vec![0u8; crate::accumulator::MAX_PROOF_BYTES + 1];
        let oversize = [RedemptionItem {
            mmr_proof: &big,
            ..items[0]
        }];
        assert!(encode_redemption_witness(&oversize).is_err());
        let mut forged_count = wire.clone();
        forged_count[1..5].copy_from_slice(&33u32.to_le_bytes());
        assert!(decode_redemption_witness(&forged_count).is_err());
        let mut forged_len = wire.clone();
        forged_len[29..33].copy_from_slice(&8193u32.to_le_bytes()); // first mmr_len
        assert!(decode_redemption_witness(&forged_len).is_err());
    }
    use super::*;
    use crate::encoding::ACC_SMT;

    #[test]
    fn ledger_witness_binds_distinct_absolute_indices() {
        let records = [
            LedgerInputProof {
                input_index: 3,
                proof: b"a",
            },
            LedgerInputProof {
                input_index: 1,
                proof: b"",
            },
        ];
        let wire = encode_ledger_witness(&records).unwrap();
        assert_eq!(
            wire,
            [2, 2, 0, 0, 0, 3, 0, 0, 0, 1, 0, 0, 0, b'a', 1, 0, 0, 0, 0, 0, 0, 0]
        );
        assert_eq!(decode_ledger_witness(&wire).unwrap(), records);
        assert!(encode_ledger_witness(&[]).is_err());
        let duplicate = [
            LedgerInputProof {
                input_index: 3,
                proof: b"a",
            },
            LedgerInputProof {
                input_index: 3,
                proof: b"b",
            },
        ];
        assert!(encode_ledger_witness(&duplicate).is_err());
        for end in 0..wire.len() {
            assert!(decode_ledger_witness(&wire[..end]).is_err());
        }
        let mut trailing = wire;
        trailing.push(0);
        assert!(decode_ledger_witness(&trailing).is_err());
    }

    #[test]
    fn ledger_witness_rejects_malformed_wire() {
        assert!(decode_ledger_witness(&[
            2, 2, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0
        ])
        .is_err());
        for count in [0u32, 33, u32::MAX] {
            let mut wire = vec![2];
            wire.extend_from_slice(&count.to_le_bytes());
            assert!(decode_ledger_witness(&wire).is_err());
        }
        assert!(decode_ledger_witness(&[1, 1, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0]).is_err());
        assert!(decode_ledger_witness(&[2, 1, 0, 0, 0, 3, 0, 0, 0, 255, 255, 255, 255]).is_err());
    }

    #[test]
    fn ledger_witness_accepts_maximum_batch_and_rejects_larger() {
        let mut records: Vec<_> = (0..32)
            .map(|input_index| LedgerInputProof {
                input_index,
                proof: b"proof",
            })
            .collect();
        let wire = encode_ledger_witness(&records).unwrap();
        assert_eq!(decode_ledger_witness(&wire).unwrap(), records);
        records.push(LedgerInputProof {
            input_index: u32::MAX,
            proof: b"",
        });
        assert!(encode_ledger_witness(&records).is_err());
    }

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
        let certs = [
            (&b"abs"[..], &b"inc"[..]),
            (&b"a2"[..], &b"i2"[..]),
            (&b"a3"[..], &b"i3"[..]),
        ];
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
        let item = crate::encoding::PayoutItem {
            participant_lock_hash: [9; 32],
            principal: 5,
            prize: 1,
        };
        let wire =
            encode_settlement_witness(&[(&b"args"[..], &[7u8; 32][..], 1, &item, &b"p"[..])]);
        let dec = decode_settlement_witness(&wire).unwrap();
        assert_eq!(dec.len(), 1);
        assert_eq!(dec[0].lock_args, b"args");
        assert_eq!(dec[0].lock_hash_type, 1);
        assert_eq!(dec[0].item, item);
        assert_eq!(dec[0].proof, b"p");
    }
}
