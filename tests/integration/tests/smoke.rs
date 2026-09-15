mod common;

use ckb_testtool::ckb_types::{
    bytes::Bytes,
    core::{DepType, ScriptHashType, TransactionBuilder, TransactionView},
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

fn run_contract(world: &mut World, name: &str) {
    let bin: Bytes = if name.starts_with('/') {
        std::fs::read(name).expect("bin").into()
    } else {
        read_bin(name)
    };
    let op = world.context.deploy_cell(bin);
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
    let tx = world.context.complete_tx(tx);
    let dump = dump_tx_json(&world.context, &tx);
    std::fs::write("/tmp/failing_tx.json", dump).unwrap();
    let c = expect_ok(&mut world.context, &tx);
    println!("{} lock cycles: {}", name, c);
}

#[test]
fn template_contract_runs() {
    let mut world = World::new(ACC_SMT);
    run_contract(
        &mut world,
        "/tmp/template-contract/target/riscv64imac-unknown-none-elf/release/template-contract",
    );
}

#[test]
fn alloc_contract_runs() {
    let mut world = World::new(ACC_SMT);
    run_contract(&mut world, "smoke-alloc");
}

#[test]
fn round_type_binary_as_lock() {
    let mut world = World::new(ACC_SMT);
    run_contract(&mut world, "round-type");
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
