//! DAOWOWAccumulatorBench — measures on-chain verification cost of the three
//! accumulator candidates on CKB-VM. The host builds a workload witness; the
//! script verifies ONE append transition and `membership` membership proofs
//! with the production verifiers, then returns 0. Cycles are measured
//! externally (ckb-testtool `verify_tx` returns consumed cycles). To sweep
//! tree sizes, the host deploys one bench script + witness per workload.
//!
//! args: [0] accumulator_id (0=SMT 1=MMR 2=IMT), [1] unused, [2] membership u8
//!
//! witness layout (strict, per accumulator):
//!   SMT: key(32) leaf(32) u32 absence_len + absence u32 inclusion_len + inclusion
//!   MMR: leaf(32) u32 old_peaks_len + old u32 new_peaks_len + new u64 old_count
//!   IMT: leaf(32) branch(1024) u64 n
//!   all: old_root(32) new_root(32) u32 proof_len + membership_proof

#![no_std]
#![no_main]

use ckb_std::ckb_constants::Source;
use ckb_std::entry;
use ckb_std::high_level::{load_script, load_witness};
use daowow_contracts_common::daowow_alloc;
use daowow_core::accumulator::{imt, mmr, smt};
use daowow_core::error::codes::*;

entry!(main);

fn err(e: i8) -> i8 {
    ckb_std::debug!("accumulator-bench error {}", e);
    e
}

struct Cursor<'a> {
    b: &'a [u8],
    off: usize,
}

impl<'a> Cursor<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], i8> {
        if self.off + n > self.b.len() {
            return Err(BENCH_ERROR_WORKLOAD);
        }
        let s = &self.b[self.off..self.off + n];
        self.off += n;
        Ok(s)
    }
    fn u32(&mut self) -> Result<u32, i8> {
        let b = self.take(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
    fn u64(&mut self) -> Result<u64, i8> {
        let b = self.take(8)?;
        Ok(u64::from_le_bytes([
            b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
        ]))
    }
    fn a32(&mut self) -> Result<[u8; 32], i8> {
        let b = self.take(32)?;
        Ok(b.try_into().unwrap())
    }
}

fn main() -> i8 {
    let script = match load_script() {
        Ok(s) => s,
        Err(_) => return err(BENCH_ERROR_WORKLOAD),
    };
    let args = script.args().raw_data();
    if args.len() != 3 {
        return err(BENCH_ERROR_WORKLOAD);
    }
    let acc = args[0];
    let membership_runs = args[2] as usize;

    let w = match load_witness(0, Source::GroupInput) {
        Ok(w) => w,
        Err(_) => return err(BENCH_ERROR_WORKLOAD),
    };
    let mut c = Cursor { b: &w, off: 0 };

    let key: [u8; 32];
    let leaf: [u8; 32];
    let old_root: [u8; 32];
    let new_root: [u8; 32];
    let membership_proof: &[u8];

    match acc {
        daowow_core::encoding::ACC_SMT => {
            key = match c.a32() {
                Ok(v) => v,
                Err(e) => return err(e),
            };
            leaf = match c.a32() {
                Ok(v) => v,
                Err(e) => return err(e),
            };
            let absence = {
                let l = match c.u32() {
                    Ok(v) => v as usize,
                    Err(e) => return err(e),
                };
                match c.take(l) {
                    Ok(v) => v,
                    Err(e) => return err(e),
                }
            };
            let inclusion = {
                let l = match c.u32() {
                    Ok(v) => v as usize,
                    Err(e) => return err(e),
                };
                match c.take(l) {
                    Ok(v) => v,
                    Err(e) => return err(e),
                }
            };
            old_root = match c.a32() {
                Ok(v) => v,
                Err(e) => return err(e),
            };
            new_root = match c.a32() {
                Ok(v) => v,
                Err(e) => return err(e),
            };
            if smt::verify_insert_certificate(&old_root, &new_root, &key, &leaf, absence, inclusion)
                .is_err()
            {
                return err(BENCH_ERROR_FAILED);
            }
            let pl = match c.u32() {
                Ok(v) => v as usize,
                Err(e) => return err(e),
            };
            membership_proof = match c.take(pl) {
                Ok(v) => v,
                Err(e) => return err(e),
            };
            if c.off != w.len() {
                return err(BENCH_ERROR_WORKLOAD);
            }
            for _ in 0..membership_runs {
                if smt::verify_membership(&new_root, &key, &leaf, membership_proof).is_err() {
                    return err(BENCH_ERROR_FAILED);
                }
            }
        }
        daowow_core::encoding::ACC_MMR => {
            leaf = match c.a32() {
                Ok(v) => v,
                Err(e) => return err(e),
            };
            let old_peaks = {
                let l = match c.u32() {
                    Ok(v) => v as usize,
                    Err(e) => return err(e),
                };
                match c.take(l) {
                    Ok(v) => v,
                    Err(e) => return err(e),
                }
            };
            let new_peaks = {
                let l = match c.u32() {
                    Ok(v) => v as usize,
                    Err(e) => return err(e),
                };
                match c.take(l) {
                    Ok(v) => v,
                    Err(e) => return err(e),
                }
            };
            let old_count = match c.u64() {
                Ok(v) => v,
                Err(e) => return err(e),
            };
            old_root = match c.a32() {
                Ok(v) => v,
                Err(e) => return err(e),
            };
            new_root = match c.a32() {
                Ok(v) => v,
                Err(e) => return err(e),
            };
            if mmr::verify_append(&old_root, &new_root, old_count, &leaf, old_peaks, new_peaks)
                .is_err()
            {
                return err(BENCH_ERROR_FAILED);
            }
            let pl = match c.u32() {
                Ok(v) => v as usize,
                Err(e) => return err(e),
            };
            membership_proof = match c.take(pl) {
                Ok(v) => v,
                Err(e) => return err(e),
            };
            if c.off != w.len() {
                return err(BENCH_ERROR_WORKLOAD);
            }
            let pos = old_count;
            for _ in 0..membership_runs {
                if mmr::verify_membership(&new_root, old_count + 1, pos, &leaf, membership_proof)
                    .is_err()
                {
                    return err(BENCH_ERROR_FAILED);
                }
            }
        }
        daowow_core::encoding::ACC_IMT => {
            leaf = match c.a32() {
                Ok(v) => v,
                Err(e) => return err(e),
            };
            let branch = match c.take(imt::IMT_BRANCH_BYTES) {
                Ok(v) => v,
                Err(e) => return err(e),
            };
            let n = match c.u64() {
                Ok(v) => v,
                Err(e) => return err(e),
            };
            old_root = match c.a32() {
                Ok(v) => v,
                Err(e) => return err(e),
            };
            new_root = match c.a32() {
                Ok(v) => v,
                Err(e) => return err(e),
            };
            if imt::verify_append(&old_root, &new_root, n, &leaf, branch).is_err() {
                return err(BENCH_ERROR_FAILED);
            }
            let pl = match c.u32() {
                Ok(v) => v as usize,
                Err(e) => return err(e),
            };
            membership_proof = match c.take(pl) {
                Ok(v) => v,
                Err(e) => return err(e),
            };
            if c.off != w.len() {
                return err(BENCH_ERROR_WORKLOAD);
            }
            for _ in 0..membership_runs {
                if imt::verify_membership(&new_root, n, &leaf, membership_proof).is_err() {
                    return err(BENCH_ERROR_FAILED);
                }
            }
        }
        _ => return err(BENCH_ERROR_WORKLOAD),
    }

    let _ = key;
    0
}

daowow_alloc!();
