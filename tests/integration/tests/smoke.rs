mod common;

use ckb_testtool::ckb_types::{
    bytes::Bytes,
    core::{ScriptHashType, TransactionBuilder, TransactionView},
    packed::*,
    prelude::*,
};
use common::*;

#[test]
fn always_success_baseline() {
    let mut world = World::new(ACC_SMT);
    let funding = world.funding_cell(2000 * SHANNONS);
    let output = CellOutputBuilder::default()
        .capacity(pack_u64(1000 * SHANNONS))
        .lock(funding.1.clone())
        .build();
    let funding2 = world.funding_cell(2000 * SHANNONS);
    let tx = TransactionBuilder::default()
        .input(CellInput::new(funding.0, 0))
        .input(CellInput::new(funding2.0, 0))
        .output(output)
        .output_data(Bytes::new())
        .witness(packed_bytes(&[]))
        .witness(packed_bytes(&[]))
        .build();
    // debug: check dep resolution manually
    {
        let ctx = &world.context;
        for (i, inp) in tx.inputs().into_iter().enumerate() {
            if let Some((cell, _)) = ctx.get_cell(&inp.previous_output()) {
                let l = cell.lock();
                println!(
                    "input {} lock hash_type={} code_hash={:#x}",
                    i,
                    u8::from(l.hash_type()),
                    l.code_hash()
                );
                if let Some(t) = cell.type_().to_opt() {
                    println!(
                        "  input {} type hash_type={} code_hash={:#x}",
                        i,
                        u8::from(t.hash_type()),
                        t.code_hash()
                    );
                }
            } else {
                println!("input {} NOT FOUND in context", i);
            }
        }
        for (i, out) in tx.outputs().into_iter().enumerate() {
            let l = out.lock();
            println!(
                "output {} lock hash_type={} code_hash={:#x}",
                i,
                u8::from(l.hash_type()),
                l.code_hash()
            );
        }
    }
    let c = expect_ok(&mut world.context, &tx);
    println!("baseline cycles: {}", c);
}

fn packed_bytes(b: &[u8]) -> ckb_testtool::ckb_types::packed::Bytes {
    pack_pbytes(b)
}

/// A transaction spending one cell locked by `name`'s binary, with no type
/// script and nothing else happening: the minimal shape that makes the binary
/// execute as a lock.
///
/// The `/tmp` transaction dump this used to write on every call is gone. It
/// was debug scaffolding on a fixed path, so two of these tests running at
/// once raced over the same file.
fn contract_as_lock_tx(world: &mut World, name: &str) -> TransactionView {
    let op = world.context.deploy_cell(read_bin(name));
    let contract_lock = world
        .context
        .build_script_with_hash_type(&op, ScriptHashType::Data1, Bytes::new())
        .unwrap();
    // input cell locked BY the contract
    let spendable = world.context.create_cell(
        CellOutputBuilder::default()
            .capacity(pack_u64(1000 * SHANNONS))
            .lock(contract_lock)
            .build(),
        Bytes::new(),
    );
    let output = CellOutputBuilder::default()
        .capacity(pack_u64(1000 * SHANNONS))
        .lock(world.always_success().1)
        .build();
    let tx = TransactionBuilder::default()
        .input(CellInput::new(spendable, 0))
        .output(output)
        .output_data(Bytes::new())
        .witness(pack_pbytes(
            WitnessArgs::new_builder().build().as_bytes().as_ref(),
        ))
        .build();
    world.context.complete_tx(tx)
}

fn run_contract(world: &mut World, name: &str) {
    let tx = contract_as_lock_tx(world, name);
    let c = expect_ok(&mut world.context, &tx);
    println!("{name} lock cycles: {c}");
}

#[test]
fn alloc_contract_runs() {
    let mut world = World::new(ACC_SMT);
    run_contract(&mut world, "smoke-alloc");
}

/// `round-type` is a type script only, and must refuse to guard a cell as a
/// lock rather than succeed by accident.
///
/// Unlike entry-shard-type and settlement-type, which carry deliberate
/// public-lock modes, round-type's `main` goes straight to the round config in
/// `Source::GroupOutput`. A lock group has inputs and never outputs, so that
/// read always fails and the script returns ROUND_ERROR_CONFIG.
///
/// This test used to assert `expect_ok` on exactly this transaction, as a
/// "the binary loads and runs" smoke, and had therefore been red for as long
/// as round-type has had its current shape — carried as a known failure rather
/// than fixed. Asserting the refusal instead makes it pin a real property: if
/// round-type ever grows a lock mode, this goes red and the change has to be
/// deliberate.
#[test]
fn round_type_binary_refuses_to_act_as_a_lock() {
    let mut world = World::new(ACC_SMT);
    let tx = contract_as_lock_tx(&mut world, "round-type");
    let err = expect_fail(&mut world.context, &tx);
    assert!(
        format!("{err}").contains("error code -17"),
        "expected ROUND_ERROR_CONFIG (-17), got: {err}"
    );
}

#[test]
fn round_type_creation_smoke() {
    let mut world = World::new(ACC_SMT);
    let cfg = default_config([7; 32], ACC_SMT);
    let round_op = world.create_round(&cfg);

    // creation replay: consume the just-created config cell and re-create it
    // identically (round-type update path = immutability)
    let (cell, data) = world.cell(&round_op);
    let funding = world.funding_cell(1000 * SHANNONS);
    let tx = TransactionBuilder::default()
        .input(CellInput::new(round_op.clone(), 0))
        .input(CellInput::new(funding.0, 0))
        .output(cell)
        .output_data(data)
        .witness(packed_bytes(&[]))
        .witness(packed_bytes(&[]))
        .build();
    let c = expect_ok(&mut world.context, &tx);
    println!("round-type update cycles: {}", c);
}
