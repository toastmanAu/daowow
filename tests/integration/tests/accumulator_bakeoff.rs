//! Milestone 3: empirical accumulator comparison on CKB-VM.
//!
//! For each candidate (SMT with insert certificates, MMR with peak lists,
//! fixed-depth incremental Merkle) and a sweep of tree sizes, this test:
//! 1. builds the tree host-side from synthetic leaves;
//! 2. constructs an append workload (old_root -> new_root) witness;
//! 3. constructs a membership-proof workload for the newest leaf;
//! 4. runs each through the accumulator-bench contract via ckb-testtool
//!    (the bench contract verifies with the production verifiers);
//! 5. records consumed cycles, proof sizes and witness sizes to
//!    `tests/vectors/accumulator_bench.json` and prints a table.

mod common;

use ckb_testtool::ckb_types::{
    bytes::Bytes,
    core::{DepType, ScriptHashType, TransactionBuilder, TransactionView},
    packed::*,
    prelude::*,
};
use common::*;
use daowow_core::accumulator::{imt, mmr, nonce_key, smt};
use daowow_core::hash::Hash32;
use std::fs;

const SIZES: &[u64] = &[0, 15, 255, 4095];

struct Sample {
    acc: &'static str,
    n: u64,
    append_cycles: u64,
    append_witness_len: usize,
    append_proof_len: usize,
    membership_cycles_per_op: u64,
    membership_proof_len: usize,
}

fn leaf_for(n: u64) -> Hash32 {
    daowow_core::hash::ckb_hash256_one(format!("daowow-bench-leaf-{n}").as_bytes())
}

fn run_bench(world: &mut World, acc_id: u8, witness: Bytes, membership_runs: u8) -> u64 {
    let op = world.context.deploy_cell(read_bin("accumulator-bench"));
    let lock = world
        .context
        .build_script_with_hash_type(
            &op,
            ScriptHashType::Data1,
            Bytes::from(vec![acc_id, 0, membership_runs]),
        )
        .unwrap();
    let spendable = world.context.create_cell(
        CellOutputBuilder::default()
            .capacity(pack_u64(1000 * SHANNONS))
            .lock(lock)
            .build(),
        Bytes::new(),
    );
    let out_lock = world.always_success().1;
    let tx = TransactionBuilder::default()
        .input(CellInput::new(spendable, 0))
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(1000 * SHANNONS))
                .lock(out_lock)
                .build(),
        )
        .output_data(Bytes::new())
        .witness(witness)
        .build();
    expect_ok(&mut world.context, &tx)
}

#[test]
fn accumulator_bakeoff() {
    let mut samples: Vec<Sample> = Vec::new();

    for &n in SIZES {
        // ---------------- SMT ----------------
        {
            let mut world = World::new(ACC_SMT);
            let mut t = smt::host::SmtHost::new();
            for i in 0..n {
                t.insert(&nonce_key(i), &leaf_for(i)).unwrap();
            }
            let key = nonce_key(n);
            let leaf = leaf_for(n);
            let absence = t.absence_proof(&[key]).unwrap();
            t.insert(&key, &leaf).unwrap();
            let inclusion = t.inclusion_proof(&[key]).unwrap();
            let old_root = {
                // recompute old root by building a tree without the last leaf
                let mut t0 = smt::host::SmtHost::new();
                for i in 0..n {
                    t0.insert(&nonce_key(i), &leaf_for(i)).unwrap();
                }
                t0.root()
            };
            let new_root = t.root();

            // append workload
            let mut w = Vec::new();
            w.extend_from_slice(&key);
            w.extend_from_slice(&leaf);
            w.extend_from_slice(&(absence.len() as u32).to_le_bytes());
            w.extend_from_slice(&absence);
            w.extend_from_slice(&(inclusion.len() as u32).to_le_bytes());
            w.extend_from_slice(&inclusion);
            w.extend_from_slice(&old_root);
            w.extend_from_slice(&new_root);
            // membership section: u32 len + proof (0 runs in append sample)
            w.extend_from_slice(&0u32.to_le_bytes());
            let append_cycles = run_bench(&mut world, ACC_SMT, w.clone().into(), 0);

            // membership workload: same witness with the proof replacing the
            // zero-length placeholder
            let mut wm = w[..w.len() - 4].to_vec();
            wm.extend_from_slice(&(inclusion.len() as u32).to_le_bytes());
            wm.extend_from_slice(&inclusion);
            let membership_cycles = run_bench(&mut world, ACC_SMT, wm.into(), 10);

            samples.push(Sample {
                acc: "SMT",
                n,
                append_cycles,
                append_witness_len: w.len(),
                append_proof_len: absence.len() + inclusion.len(),
                membership_cycles_per_op: (membership_cycles - append_cycles) / 10,
                membership_proof_len: inclusion.len(),
            });
        }

        // ---------------- MMR ----------------
        {
            let mut world = World::new(ACC_MMR);
            let mut t = mmr::host::MmrHost::new();
            for i in 0..n {
                t.append(&leaf_for(i)).unwrap();
            }
            let old_root = t.root().unwrap();
            let mut wire_old = vec![t.peaks().len() as u8];
            for p in t.peaks() {
                wire_old.extend_from_slice(p);
            }
            t.append(&leaf_for(n)).unwrap();
            let new_root = t.root().unwrap();
            let mut wire_new = vec![t.peaks().len() as u8];
            for p in t.peaks() {
                wire_new.extend_from_slice(p);
            }
            let mem_proof = t.membership_proof(n).unwrap();

            let mut w = Vec::new();
            w.extend_from_slice(&leaf_for(n));
            w.extend_from_slice(&(wire_old.len() as u32).to_le_bytes());
            w.extend_from_slice(&wire_old);
            w.extend_from_slice(&(wire_new.len() as u32).to_le_bytes());
            w.extend_from_slice(&wire_new);
            w.extend_from_slice(&n.to_le_bytes());
            w.extend_from_slice(&old_root);
            w.extend_from_slice(&new_root);
            w.extend_from_slice(&0u32.to_le_bytes());
            let append_cycles = run_bench(&mut world, ACC_MMR, w.clone().into(), 0);

            let mut wm = w[..w.len() - 4].to_vec();
            wm.extend_from_slice(&(mem_proof.len() as u32).to_le_bytes());
            wm.extend_from_slice(&mem_proof);
            let membership_cycles = run_bench(&mut world, ACC_MMR, wm.into(), 10);

            samples.push(Sample {
                acc: "MMR",
                n,
                append_cycles,
                append_witness_len: w.len(),
                append_proof_len: wire_old.len() + wire_new.len(),
                membership_cycles_per_op: (membership_cycles - append_cycles) / 10,
                membership_proof_len: mem_proof.len(),
            });
        }

        // ---------------- IMT ----------------
        {
            let mut world = World::new(ACC_IMT);
            let mut t = imt::host::ImtHost::new();
            for i in 0..n {
                t.append(&leaf_for(i));
            }
            let old_root = t.root();
            let branch = t.branch_for(n);
            t.append(&leaf_for(n));
            let new_root = t.root();
            let mem_proof = t.membership_proof(n).unwrap();

            let mut w = Vec::new();
            w.extend_from_slice(&leaf_for(n));
            w.extend_from_slice(&branch);
            w.extend_from_slice(&n.to_le_bytes());
            w.extend_from_slice(&old_root);
            w.extend_from_slice(&new_root);
            w.extend_from_slice(&0u32.to_le_bytes());
            let append_cycles = run_bench(&mut world, ACC_IMT, w.clone().into(), 0);

            let mut wm = w[..w.len() - 4].to_vec();
            wm.extend_from_slice(&(mem_proof.len() as u32).to_le_bytes());
            wm.extend_from_slice(&mem_proof);
            let membership_cycles = run_bench(&mut world, ACC_IMT, wm.into(), 10);

            samples.push(Sample {
                acc: "IMT",
                n,
                append_cycles,
                append_witness_len: w.len(),
                append_proof_len: imt::IMT_BRANCH_BYTES,
                membership_cycles_per_op: (membership_cycles - append_cycles) / 10,
                membership_proof_len: imt::IMT_BRANCH_BYTES,
            });
        }
    }

    println!("\n================ accumulator bakeoff (CKB-VM cycles) ================");
    println!(
        "{:>4} {:>6} {:>14} {:>12} {:>12} {:>14} {:>10}",
        "acc", "n", "append_cycles", "append_wit", "append_prf", "mem_cycles/op", "mem_prf"
    );
    for s in &samples {
        println!(
            "{:>4} {:>6} {:>14} {:>12} {:>12} {:>14} {:>10}",
            s.acc,
            s.n,
            s.append_cycles,
            s.append_witness_len,
            s.append_proof_len,
            s.membership_cycles_per_op,
            s.membership_proof_len
        );
    }
    println!("=====================================================================");

    let json = serde_json::json!({
        "description": "DAOWOW accumulator bakeoff, measured with ckb-testtool (ckb-vm), rustc/ckb versions in toolchain.lock.md",
        "sizes": SIZES,
        "samples": samples.iter().map(|s| serde_json::json!({
            "accumulator": s.acc,
            "leaves_before": s.n,
            "append_cycles": s.append_cycles,
            "append_witness_bytes": s.append_witness_len,
            "append_proof_bytes": s.append_proof_len,
            "membership_cycles_per_op": s.membership_cycles_per_op,
            "membership_proof_bytes": s.membership_proof_len,
        })).collect::<Vec<_>>(),
    });
    let out = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../vectors/accumulator_bench.json"
    );
    fs::write(out, serde_json::to_string_pretty(&json).unwrap()).expect("write bench json");
    println!("written {}", out);
}
