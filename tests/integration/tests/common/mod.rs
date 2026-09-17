//! Shared test harness: deploys the DAOWOW contracts into a ckb-testtool
//! context and provides builders for round/shard/entry/DAO/settlement
//! transactions.

use ckb_testtool::ckb_types::{
    bytes::Bytes,
    core::{DepType, ScriptHashType, TransactionBuilder, TransactionView},
    packed::*,
    prelude::*,
};
use ckb_testtool::context::Context;
use daowow_core::accumulator::nonce_key;
pub use daowow_core::accumulator::smt::host::SmtHost;
pub use daowow_core::encoding::*;
pub use daowow_core::hash::Hash32;
use std::path::PathBuf;

pub const MAX_CYCLES: u64 = 70_000_000;
pub const SHANNONS: u64 = 100_000_000;

/// Unambiguous packed-value constructors (dual Pack traits are in scope via
/// glob imports).
pub fn pack_u64(v: u64) -> Uint64 {
    use ckb_testtool::ckb_types::prelude::Pack;
    v.pack()
}

pub fn pack_byte(v: u8) -> Byte {
    Byte::from(v)
}

/// Convert raw bytes into the molecule `packed::Bytes` wrapper (length
/// handled by the Pack impl).
pub fn pack_pbytes(b: &[u8]) -> ckb_testtool::ckb_types::packed::Bytes {
    use ckb_testtool::ckb_types::prelude::Pack;
    ckb_testtool::ckb_types::bytes::Bytes::from(b.to_vec()).pack()
}

pub fn bin_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/riscv64imac-unknown-none-elf/release")
}

pub fn read_bin(name: &str) -> Bytes {
    std::fs::read(bin_dir().join(name))
        .expect("contract binary (build with: cargo build --target riscv64imac-unknown-none-elf --release -p <contract>)")
        .into()
}

/// Script references recorded in the round config (hash_type = data = 0 for
/// our contracts, type = 1 for the native DAO).
#[derive(Clone, Copy)]
pub struct Deps {
    pub round_type: ScriptRef,
    pub entry_shard_type: ScriptRef,
    pub entry_lock: ScriptRef,
    pub dao_lock: ScriptRef,
    pub settlement_type: ScriptRef,
    pub dao_type: ScriptRef,
    pub accumulator_id: u8,
}

pub struct World {
    pub config_hash: Hash32,
    pub context: Context,
    pub deps: Deps,
    /// cell carrying the native DAO type script (for cell deps)
    pub dao_cell_op: OutPoint,
    /// the DAO type script as used in transaction outputs (code_hash =
    /// registered holder type hash)
    dao_type_script: Script,
}

pub fn dao_binary() -> Bytes {
    let data: Vec<u8> = ckb_system_scripts::BUNDLED_CELL
        .get("specs/cells/dao")
        .expect("bundled dao binary")
        .to_vec();
    Bytes::from(data)
}

pub fn full_config(cfg: &RoundConfigV1, deps: &Deps) -> RoundConfigV1 {
    let mut c = *cfg;
    c.entry_lock = deps.entry_lock;
    c.dao_lock = deps.dao_lock;
    c.settlement_type = deps.settlement_type;
    c.entry_shard_type = deps.entry_shard_type;
    c.dao_type = deps.dao_type;
    c
}

pub fn default_prize_schedule() -> daowow_core::schedule::PrizeSchedule {
    daowow_core::schedule::PrizeSchedule::new(&[40, 25, 20, 10, 5]).unwrap()
}

pub fn creation_schedule_witness(schedule: Vec<u8>) -> Bytes {
    WitnessArgs::new_builder()
        .lock(Some(Bytes::from(vec![0u8; 65])).pack())
        .output_type(Some(Bytes::from(schedule)).pack())
        .build()
        .as_bytes()
}

pub fn default_config(round_id: Hash32, accumulator_id: u8) -> RoundConfigV1 {
    RoundConfigV1 {
        version: 1,
        round_id,
        ticket_price: 100 * SHANNONS,
        minimum_tickets: 1,
        maximum_tickets: 0,
        entry_start: 0,
        entry_end: 100,
        aggregation_deadline: 200,
        dao_term_periods: 1,
        entry_shard_count: 4,
        prize_schedule_hash: [9; 32],
        fee_policy_hash: [8; 32],
        keeper_policy_hash: [7; 32],
        flags: 0,
        accumulator_id,
        entry_lock: ScriptRef {
            code_hash: [0; 32],
            hash_type: 0,
        },
        dao_lock: ScriptRef {
            code_hash: [0; 32],
            hash_type: 0,
        },
        settlement_type: ScriptRef {
            code_hash: [0; 32],
            hash_type: 0,
        },
        entry_shard_type: ScriptRef {
            code_hash: [0; 32],
            hash_type: 0,
        },
        dao_type: ScriptRef {
            code_hash: [0; 32],
            hash_type: 1,
        },
    }
}

pub fn empty_root(accumulator_id: u8) -> Hash32 {
    match accumulator_id {
        ACC_SMT => [0u8; 32],
        ACC_MMR => daowow_core::accumulator::mmr::bag_peaks(&[]).unwrap(),
        ACC_IMT => daowow_core::accumulator::imt::zero_at(daowow_core::accumulator::imt::IMT_DEPTH),
        _ => panic!("bad accumulator id"),
    }
}

impl World {
    /// Deploy every contract and the native DAO cell.
    pub fn new(accumulator_id: u8) -> Self {
        let mut context = Context::new_with_deterministic_rng();

        let round_type_op = context.deploy_cell(read_bin("round-type"));
        let shard_type_op = context.deploy_cell(read_bin("entry-shard-type"));
        let entry_lock_op = context.deploy_cell(read_bin("entry-lock"));
        let dao_lock_op = context.deploy_cell(read_bin("dao-lock"));
        let settle_type_op = context.deploy_cell(read_bin("settlement-type"));
        let _dao_raw_op = context.deploy_cell(dao_binary());

        fn script_ref_of(op: &OutPoint, context: &mut Context) -> ScriptRef {
            let script = context
                .build_script_with_hash_type(op, ScriptHashType::Data1, Bytes::new())
                .unwrap();
            ScriptRef {
                code_hash: script.code_hash().raw_data().as_ref().try_into().unwrap(),
                hash_type: 2,
            }
        }
        let round_type = script_ref_of(&round_type_op, &mut context);
        let entry_shard_type = script_ref_of(&shard_type_op, &mut context);
        let entry_lock = script_ref_of(&entry_lock_op, &mut context);
        let dao_lock = script_ref_of(&dao_lock_op, &mut context);
        let settlement_type = script_ref_of(&settle_type_op, &mut context);

        // Native DAO holder cell: its type script is registered under the
        // script's own hash (calc_script_hash), mirroring how genesis
        // self-consistently deploys system scripts. The effective DAO type
        // script for transactions uses that hash as its code_hash.
        let holder_type = {
            let op = context.deploy_cell(ckb_testtool::builtin::ALWAYS_SUCCESS.clone());
            ScriptBuilder::default()
                .code_hash(Byte32::new({
                    let t = context.get_cell(&op).unwrap().0.type_().to_opt().unwrap();
                    t.calc_script_hash().raw_data().as_ref().try_into().unwrap()
                }))
                .hash_type(pack_byte(ScriptHashType::Type as u8))
                .args(Bytes::new())
                .build()
        };
        // script used in outputs: code_hash = the registered holder hash
        let dao_type_script = ScriptBuilder::default()
            .code_hash(holder_type.calc_script_hash())
            .hash_type(pack_byte(ScriptHashType::Type as u8))
            .args(Bytes::new())
            .build();
        // what on-chain `load_cell_type_hash` returns for DAO cells — this is
        // what cfg.dao_type.code_hash must equal
        let dao_type_code_hash: [u8; 32] = dao_type_script
            .calc_script_hash()
            .raw_data()
            .as_ref()
            .try_into()
            .unwrap();
        let holder_lock = {
            let op = context.deploy_cell(ckb_testtool::builtin::ALWAYS_SUCCESS.clone());
            context.build_script(&op, Bytes::new()).unwrap()
        };
        let dao_output = CellOutputBuilder::default()
            .capacity(pack_u64(200 * SHANNONS))
            .lock(holder_lock)
            .type_(Some(holder_type.clone()).pack())
            .build();
        let dao_cell_op = context.create_cell(dao_output, dao_binary());

        let deps = Deps {
            round_type,
            entry_shard_type,
            entry_lock,
            dao_lock,
            settlement_type,
            dao_type: ScriptRef {
                code_hash: dao_type_code_hash,
                hash_type: 1,
            },
            accumulator_id,
        };

        context.set_capture_debug(true);
        World {
            context,
            deps,
            dao_cell_op,
            dao_type_script,
            config_hash: [0; 32],
        }
    }

    pub fn always_success(&mut self) -> (OutPoint, Script) {
        let op = self
            .context
            .deploy_cell(ckb_testtool::builtin::ALWAYS_SUCCESS.clone());
        // data1 deployment => VM V1 (matches our contracts)
        let lock = self
            .context
            .build_script_with_hash_type(&op, ScriptHashType::Data1, Bytes::new())
            .unwrap();
        (op, lock)
    }

    /// A fresh funding cell; returns out point + lock script.
    pub fn funding_cell(&mut self, capacity: u64) -> (OutPoint, Script) {
        let (op, lock) = self.always_success();
        let output = CellOutputBuilder::default()
            .capacity(pack_u64(capacity))
            .lock(lock.clone())
            .build();
        let op = self.context.create_cell(output, Bytes::new());
        (op, lock)
    }

    pub fn participant_hash(lock: &Script) -> Hash32 {
        lock.calc_script_hash()
            .raw_data()
            .as_ref()
            .try_into()
            .unwrap()
    }

    pub fn script_for(&mut self, r: &ScriptRef, args: Bytes) -> Script {
        let code_hash = r.code_hash;
        let hash_type = r.hash_type;
        let op = self
            .context
            .get_cell_by_data_hash(&Byte32::new(code_hash))
            .expect("deployed contract");
        self.context
            .build_script_with_hash_type(
                &op,
                match hash_type {
                    0 => ScriptHashType::Data,
                    2 => ScriptHashType::Data1,
                    1 => ScriptHashType::Type,
                    _ => panic!("bad hash type"),
                },
                args,
            )
            .unwrap()
    }

    pub fn round_config_dep(&mut self, op: &OutPoint) -> CellDep {
        CellDepBuilder::default()
            .out_point(op.clone())
            .dep_type(pack_byte(DepType::Code as u8))
            .build()
    }

    /// Create the immutable round config cell.
    pub fn create_round(&mut self, cfg: &RoundConfigV1) -> OutPoint {
        let (_, lock) = self.always_success();
        let c = full_config(cfg, &self.deps);
        self.config_hash = c.commitment();
        let args = Bytes::from(c.round_id.to_vec());
        let round_type_ref = self.deps.round_type;
        let round_type_script = self.script_for(&round_type_ref, args);
        let output = CellOutputBuilder::default()
            .capacity(pack_u64(400 * SHANNONS))
            .lock(lock)
            .type_(Some(round_type_script).pack())
            .build();
        self.context
            .create_cell(output, Bytes::from(c.encode().to_vec()))
    }

    /// Create an initial (empty, OPEN) shard cell.
    pub fn create_shard(
        &mut self,
        cfg: &RoundConfigV1,
        shard_id: u32,
        _type_id: u64,
    ) -> (OutPoint, EntryShardDataV1) {
        let lock = self.shard_public_lock();
        let shard = EntryShardDataV1 {
            round_id: cfg.round_id,
            shard_id,
            state: SHARD_STATE_OPEN,
            sequence: 0,
            entry_count: 0,
            ticket_count: 0,
            principal_total: 0,
            accumulator_root: empty_root(cfg.accumulator_id),
        };
        let shard_type_ref = self.deps.entry_shard_type;
        let mut args = full_config(cfg, &self.deps).commitment().to_vec();
        args.extend_from_slice(&shard_id.to_le_bytes());
        let shard_type_script = self.script_for(&shard_type_ref, Bytes::from(args));
        let output = CellOutputBuilder::default()
            .capacity(pack_u64(300 * SHANNONS))
            .lock(lock)
            .type_(Some(shard_type_script).pack())
            .build();
        let op = self
            .context
            .create_cell(output, Bytes::from(shard.encode().to_vec()));
        (op, shard)
    }

    pub fn shard_public_lock(&mut self) -> Script {
        let r = self.deps.entry_shard_type;
        self.script_for(&r, Bytes::from(vec![0]))
    }

    pub fn entry_lock_script(&mut self, participant_lock_hash: &Hash32) -> Script {
        let r = self.deps.entry_lock;
        let mut args = participant_lock_hash.to_vec();
        args.extend_from_slice(&self.config_hash);
        self.script_for(&r, Bytes::from(args))
    }

    /// Claim NFT type script for one ticket of this round (after `create_round`).
    pub fn claim_type_script(&mut self, shard_id: u32, position: u64) -> Script {
        let r = self.deps.entry_shard_type;
        let args = daowow_core::claim::ClaimArgs {
            commitment: self.config_hash,
            shard_id,
            position,
        }
        .encode();
        self.script_for(&r, Bytes::from(args.to_vec()))
    }

    /// Winner memento type script for one ticket (after `create_round`).
    pub fn memento_type_script(&mut self, shard_id: u32, position: u64) -> Script {
        let r = self.deps.entry_shard_type;
        let args = daowow_core::memento::MementoArgs {
            commitment: self.config_hash,
            shard_id,
            position,
        }
        .encode();
        self.script_for(&r, Bytes::from(args.to_vec()))
    }

    pub fn dao_lock_script(&mut self, round_id: &Hash32, batch_id: u64) -> Script {
        self.dao_lock_script_with_digest(round_id, batch_id, &[0; 32])
    }

    pub fn dao_lock_script_with_digest(
        &mut self,
        round_id: &Hash32,
        batch_id: u64,
        digest: &Hash32,
    ) -> Script {
        let r = self.deps.dao_lock;
        let mut args = round_id.to_vec();
        args.extend_from_slice(&batch_id.to_le_bytes());
        args.extend_from_slice(&self.config_hash);
        args.extend_from_slice(digest);
        self.script_for(&r, Bytes::from(args))
    }

    /// The native DAO type script for transaction outputs (its code_hash
    /// resolves to the holder cell registered in this context).
    pub fn dao_type_script(&self) -> Script {
        self.dao_type_script.clone()
    }

    pub fn settlement_script(&mut self, type_id: u64) -> Script {
        self.settlement_script_with_digest(type_id, &[0; 32])
    }

    pub fn settlement_script_with_digest(&mut self, type_id: u64, digest: &Hash32) -> Script {
        let r = self.deps.settlement_type;
        let mut args = self.config_hash.to_vec();
        args.extend_from_slice(&type_id.to_le_bytes());
        args.extend_from_slice(digest);
        self.script_for(&r, Bytes::from(args))
    }

    pub fn settlement_public_lock(&mut self) -> Script {
        let r = self.deps.settlement_type;
        self.script_for(&r, Bytes::from(vec![0]))
    }

    pub fn cell(&self, op: &OutPoint) -> (CellOutput, Bytes) {
        self.context.get_cell(op).unwrap()
    }
}

pub fn make_entry(
    cfg: &RoundConfigV1,
    shard: &EntryShardDataV1,
    participant_lock_hash: &Hash32,
    tickets: u64,
    entropy_commitment: &Hash32,
) -> EntryDataV1 {
    EntryDataV1 {
        round_id: cfg.round_id,
        shard_id: shard.shard_id,
        participant_lock_hash: *participant_lock_hash,
        ticket_count: tickets,
        principal: tickets * cfg.ticket_price,
        position_base: shard.ticket_count,
        entry_nonce: shard.entry_count,
        entropy_commitment: *entropy_commitment,
    }
}

/// Build a batch of entries with nonce/position advancing correctly inside
/// the transaction.
pub fn make_entry_batch(
    cfg: &RoundConfigV1,
    shard: &EntryShardDataV1,
    participant_lock_hash: &Hash32,
    ticket_counts: &[u64],
    commitments: &[Hash32],
) -> Vec<EntryDataV1> {
    let mut out = Vec::new();
    let mut running_tickets = shard.ticket_count;
    for (i, t) in ticket_counts.iter().enumerate() {
        out.push(EntryDataV1 {
            round_id: cfg.round_id,
            shard_id: shard.shard_id,
            participant_lock_hash: *participant_lock_hash,
            ticket_count: *t,
            principal: t * cfg.ticket_price,
            position_base: running_tickets,
            entry_nonce: shard.entry_count + i as u64,
            entropy_commitment: commitments[i],
        });
        running_tickets += t;
    }
    out
}

pub fn entry_cell_capacity(entry: &EntryDataV1) -> u64 {
    // capacity field (8) + data (132) + lock (33 + 32 args); no type script
    entry.principal + ((8 + ENTRY_DATA_SIZE as u64) + (33 + 64)) * SHANNONS
}

/// Minimum capacity of a claim cell under `lock` (shannons). CKB counts a
/// script as code_hash + hash_type + args, not its molecule serialization.
pub fn claim_cell_capacity(lock: &Script) -> u64 {
    let lock_size = 32 + 1 + lock.args().raw_data().len() as u64;
    daowow_core::claim::claim_occupied_capacity(lock_size)
}

/// One claim output per ticket of `entries`, locked by `lock_for(participant_lock_hash)`.
/// The lock returned must hash to that participant hash (the test's own lock).
pub fn claim_outputs_for(
    world: &mut World,
    entries: &[EntryDataV1],
    lock_for: &dyn Fn(&Hash32) -> Script,
) -> Vec<(CellOutput, Bytes)> {
    let mut out = Vec::new();
    for e in entries {
        let lock = lock_for(&e.participant_lock_hash);
        for i in 0..e.ticket_count {
            let position = e.position_base + i;
            let type_script = world.claim_type_script(e.shard_id, position);
            let args = daowow_core::claim::ClaimArgs {
                commitment: world.config_hash,
                shard_id: e.shard_id,
                position,
            };
            let cell = CellOutputBuilder::default()
                .capacity(pack_u64(claim_cell_capacity(&lock)))
                .lock(lock.clone())
                .type_(Some(type_script).pack())
                .build();
            out.push((
                cell,
                Bytes::from(daowow_core::claim::initial_state_bytes(&args).to_vec()),
            ));
        }
    }
    out
}

/// A live claim cell for `(shard_id, position)` under `lock`, carrying the
/// initial paid-set state. Seeds history only; the claim script does not run.
pub fn seed_claim(
    world: &mut World,
    lock: &Script,
    shard_id: u32,
    position: u64,
) -> (OutPoint, daowow_core::claim::ClaimArgs) {
    let args = daowow_core::claim::ClaimArgs {
        commitment: world.config_hash,
        shard_id,
        position,
    };
    let type_script = world.claim_type_script(shard_id, position);
    let cell = CellOutputBuilder::default()
        .capacity(pack_u64(claim_cell_capacity(lock)))
        .lock(lock.clone())
        .type_(Some(type_script).pack())
        .build();
    let op = world.context.create_cell(
        cell,
        Bytes::from(daowow_core::claim::initial_state_bytes(&args).to_vec()),
    );
    (op, args)
}

pub fn redemption_witness(
    items: &[daowow_core::witness::RedemptionItem<'_>],
) -> ckb_testtool::ckb_types::packed::Bytes {
    pack_pbytes(&daowow_core::witness::encode_redemption_witness(items).unwrap())
}

pub fn smt_leaf(entry: &EntryDataV1) -> Hash32 {
    daowow_core::leaf::entry_leaf(entry)
}

pub fn smt_key(entry: &EntryDataV1) -> Hash32 {
    nonce_key(entry.entry_nonce)
}

pub fn smt_append_witness(entries: &[EntryDataV1], certs: &[(&[u8], &[u8])]) -> Bytes {
    daowow_core::witness::encode_shard_append_witness_smt(entries, certs).into()
}

pub fn aggregation_witness(proof: &[u8]) -> Bytes {
    daowow_core::witness::encode_aggregation_witness(proof).into()
}

pub fn expect_ok(context: &mut Context, tx: &TransactionView) -> u64 {
    let tx = context.complete_tx(tx.clone());
    match context.verify_tx(&tx, MAX_CYCLES) {
        Ok(cycles) => cycles,
        Err(e) => {
            for m in context.captured_messages() {
                eprintln!("[script] {}", m.message);
            }
            panic!("tx should pass but failed: {}\ntx: {}", e, hex_tx(&tx))
        }
    }
}

/// Dump a tx as mock JSON for external ckb-debugger runs.
pub fn dump_tx_json(context: &Context, tx: &TransactionView) -> String {
    let repr = context.dump_tx(tx).expect("dump tx");
    serde_json::to_string_pretty(&repr).expect("json")
}

/// Replace the mock cell at `op` with `tx`'s output at `out_index`, chaining
/// transactions (testtool mocks don't consume inputs).
pub fn chain_cell(world: &mut World, op: &OutPoint, tx: &TransactionView, out_index: usize) {
    let output = tx.outputs().get(out_index).unwrap();
    let data = tx.outputs_data().get(out_index).unwrap().raw_data();
    world
        .context
        .create_cell_with_out_point(op.clone(), output, data);
}

/// A fully sealed round (every shard frozen, aggregated in a single batch
/// and closed) plus a canonical entropy record cell dep, for retirement
/// tests. `total_tickets` must divide evenly across `shards`.
pub struct SealedRound {
    pub config_dep: CellDep,
    pub entropy_dep: CellDep,
    pub schedule: daowow_core::schedule::PrizeSchedule,
    pub non_winning_shard: u32,
    pub non_winning_position: u64,
    pub winning_shard: u32,
    pub winning_position: u64,
    pub prize_index: u32,
    pub universe: u64,
    /// `(batch_id, digest)` of every accepted batch across every shard, in the
    /// exact identities `prize_source` uses — the real obligation universe a
    /// winner must fully discharge before retiring.
    pub batches: Vec<(u64, Hash32)>,
}

/// Witness carrying the committed prize schedule in `WitnessArgs.input_type`
/// at the retiring claim's group input, which is where `retire()` reads it.
///
/// The `lock` field carries a 65-byte placeholder so this mirrors the shape a
/// real `secp256k1_blake160_sighash_all` retire transaction has: the signature
/// occupies `lock`, the schedule occupies `input_type`, and a single-input
/// retire is buildable. Reading the schedule as the raw witness body, as an
/// earlier revision did, made that shape impossible — the same witness cannot
/// be both a `WitnessArgs` and bare `PrizeSchedule` bytes.
pub fn schedule_witness(
    schedule: &daowow_core::schedule::PrizeSchedule,
) -> ckb_testtool::ckb_types::packed::Bytes {
    pack_pbytes(
        &WitnessArgs::new_builder()
            .lock(Some(Bytes::from(vec![0u8; 65])).pack())
            .input_type(Some(Bytes::from(schedule.encode())).pack())
            .build()
            .as_bytes(),
    )
}

/// Build a sealed round with `shards` entry shards sharing `total_tickets`
/// evenly, seal it, and register the canonical entropy record as a cell dep.
/// Identifies one non-winning and one winning `(shard_id, position)` from the
/// real computed draw so retirement tests exercise both branches.
pub fn sealed_round_with_entropy(
    world: &mut World,
    shards: u32,
    total_tickets: u64,
) -> SealedRound {
    assert_eq!(
        total_tickets % shards as u64,
        0,
        "sealed_round_with_entropy: total_tickets must divide evenly across shards"
    );
    let tickets_per_shard = total_tickets / shards as u64;
    let schedule = default_prize_schedule();
    let round_id = daowow_core::hash::ckb_hash256(&[
        b"claim-retirement-fixture",
        &shards.to_le_bytes(),
        &total_tickets.to_le_bytes(),
    ]);
    let mut base_cfg = default_config(round_id, ACC_MMR);
    base_cfg.entry_shard_count = shards;
    base_cfg.minimum_tickets = 1;
    base_cfg.prize_schedule_hash = schedule.commitment();
    let round_op = world.create_round(&base_cfg);
    let cfg = full_config(&base_cfg, &world.deps);

    let mut ledgers = Vec::new();
    let mut batches: Vec<(u64, Hash32)> = Vec::new();
    for shard_id in 0..shards {
        let entries: Vec<EntryDataV1> = (0..tickets_per_shard)
            .map(|nonce| EntryDataV1 {
                round_id: cfg.round_id,
                shard_id,
                participant_lock_hash: [0x11; 32],
                ticket_count: 1,
                principal: cfg.ticket_price,
                position_base: nonce,
                entry_nonce: nonce,
                entropy_commitment: [nonce as u8; 32],
            })
            .collect();
        let leaves: Vec<Hash32> = entries.iter().map(daowow_core::leaf::entry_leaf).collect();
        let mut host = daowow_core::accumulator::mmr::host::MmrHost::new();
        for leaf in &leaves {
            host.append(leaf).unwrap();
        }
        let root = host.root().unwrap();
        let proofs: Vec<Vec<u8>> = (0..tickets_per_shard)
            .map(|i| host.membership_proof(i).unwrap())
            .collect();
        let proof_refs: Vec<&[u8]> = proofs.iter().map(Vec::as_slice).collect();
        let frozen = EntryShardDataV1 {
            round_id: cfg.round_id,
            shard_id,
            state: SHARD_STATE_FROZEN,
            sequence: tickets_per_shard,
            entry_count: tickets_per_shard,
            ticket_count: tickets_per_shard,
            principal_total: tickets_per_shard * cfg.ticket_price,
            accumulator_root: root,
        };
        let capacities = vec![1000 * SHANNONS; tickets_per_shard as usize];
        let state = daowow_core::lifecycle::AggregationState::new(&cfg, &frozen).unwrap();
        let (accepted, receipt) = state
            .accept(&cfg, &entries, &capacities, &proof_refs)
            .unwrap();
        batches.push((
            daowow_core::lifecycle::batch_id(shard_id, 0).unwrap(),
            receipt.digest,
        ));
        let closed = accepted
            .close(&cfg, daowow_core::epoch::absolute_epoch_since(200).unwrap())
            .unwrap();
        ledgers.push(closed);
    }

    let seal = daowow_core::seal::RoundSeal::new(&cfg, &ledgers).unwrap();
    let record =
        daowow_core::seal::EntropyRecord::new(seal, 300, [1; 32], [[2; 32], [3; 32], [4; 32]])
            .unwrap();
    let universe = record.seal().total_accepted_batches().unwrap();

    let draw = daowow_core::computed_draw::ComputedDraw::new(&cfg, &record, &schedule).unwrap();
    let total = draw.total_tickets();
    let drawn = draw.positions();
    let (prize_index, winning_global) = drawn[0];
    let (winning_shard, winning_position) = draw.locate(winning_global).unwrap();
    let non_winning_global = (0..total)
        .find(|p| !drawn.iter().any(|(_, g)| g == p))
        .expect("sealed_round_with_entropy: no non-winning ticket in this fixture");
    let (non_winning_shard, non_winning_position) = draw.locate(non_winning_global).unwrap();

    let public_lock = world.shard_public_lock();
    let shard_ref = world.deps.entry_shard_type;
    let mut entropy_args = cfg.commitment().to_vec();
    entropy_args.extend_from_slice(&0u32.to_le_bytes());
    let entropy_type = world.script_for(&shard_ref, Bytes::from(entropy_args));
    let entropy_op = world.context.create_cell(
        CellOutputBuilder::default()
            .capacity(pack_u64(60_000 * SHANNONS))
            .lock(public_lock)
            .type_(Some(entropy_type).pack())
            .build(),
        Bytes::from(record.encode()),
    );
    let entropy_dep = CellDepBuilder::default()
        .out_point(entropy_op)
        .dep_type(pack_byte(DepType::Code as u8))
        .build();

    SealedRound {
        config_dep: world.round_config_dep(&round_op),
        entropy_dep,
        schedule,
        non_winning_shard,
        non_winning_position,
        winning_shard,
        winning_position,
        prize_index: prize_index as u32,
        universe,
        batches,
    }
}

/// Minimum capacity of a memento cell under `lock` (shannons). Mirrors
/// `claim_cell_capacity`: CKB counts a script as code_hash + hash_type +
/// args, not its molecule serialization.
pub fn memento_cell_capacity(lock: &Script) -> u64 {
    let lock_size = 32 + 1 + lock.args().raw_data().len() as u64;
    daowow_core::memento::memento_occupied_capacity(lock_size)
}

/// A claim for `round`'s winning ticket, pre-loaded with a fully paid
/// `PrizeRedemptionState`: one recorded source per accepted batch of the
/// sealed round, using the round's real `prize_source` identities (mirrors
/// the incremental-host pattern in `claim_redemption.rs`). `retire_decision`
/// requires exactly `paid_count == universe` for a winner to retire.
pub fn seed_paid_claim(
    world: &mut World,
    lock: &Script,
    round: &SealedRound,
) -> (OutPoint, daowow_core::claim::ClaimArgs) {
    let args = daowow_core::claim::ClaimArgs {
        commitment: world.config_hash,
        shard_id: round.winning_shard,
        position: round.winning_position,
    };
    let ticket = args.ticket_id();
    let mut host = SmtHost::new();
    let mut state = daowow_core::redemption::PrizeRedemptionState::new(ticket);
    for (i, (batch_id, digest)) in round.batches.iter().enumerate() {
        let source = daowow_core::redemption::prize_source(&world.config_hash, *batch_id, digest);
        let key = daowow_core::redemption::prize_obligation_key(&ticket, &source);
        let absence = host.absence_proof(&[key]).unwrap();
        let amount = (i as u64 + 1) * SHANNONS;
        state = state
            .record_verified_prize(&source, amount, &absence)
            .unwrap();
        host.insert(
            &key,
            &daowow_core::redemption::prize_payment_leaf(&ticket, &source, amount),
        )
        .unwrap();
    }
    let type_script = world.claim_type_script(round.winning_shard, round.winning_position);
    let cell = CellOutputBuilder::default()
        .capacity(pack_u64(claim_cell_capacity(lock)))
        .lock(lock.clone())
        .type_(Some(type_script).pack())
        .build();
    let op = world
        .context
        .create_cell(cell, Bytes::from(state.encode().to_vec()));
    (op, args)
}

/// A claim for `round.winning_shard/position`, pre-loaded with `count`
/// recorded sources (out of the round's real obligation universe), using the
/// round's real `prize_source` identities in order. `count < round.universe`
/// leaves the claim owing the rest, so `retire_decision` refuses it as an
/// incomplete winner (`CLAIM_ERROR_INCOMPLETE`); `count == round.universe`
/// matches `seed_paid_claim`'s fully discharged winner.
pub fn seed_claim_with_paid_count(
    world: &mut World,
    lock: &Script,
    round: &SealedRound,
    count: u64,
) -> (OutPoint, daowow_core::claim::ClaimArgs) {
    seed_claim_with_paid_count_at(
        world,
        lock,
        round,
        round.winning_shard,
        round.winning_position,
        count,
    )
}

/// As `seed_claim_with_paid_count`, but for an arbitrary identity rather than
/// the round's winner. Seeding a NON-winning identity with payments recorded
/// builds a state correct operation cannot produce — only a drawn ticket can
/// ever have discharged a source — which is what the retire path reports as
/// CLAIM_ERROR_IMPOSSIBLE rather than as an ordinary early retire.
pub fn seed_claim_with_paid_count_at(
    world: &mut World,
    lock: &Script,
    round: &SealedRound,
    shard_id: u32,
    position: u64,
    count: u64,
) -> (OutPoint, daowow_core::claim::ClaimArgs) {
    let args = daowow_core::claim::ClaimArgs {
        commitment: world.config_hash,
        shard_id,
        position,
    };
    let ticket = args.ticket_id();
    let mut host = SmtHost::new();
    let mut state = daowow_core::redemption::PrizeRedemptionState::new(ticket);
    for (i, (batch_id, digest)) in round.batches.iter().take(count as usize).enumerate() {
        let source = daowow_core::redemption::prize_source(&world.config_hash, *batch_id, digest);
        let key = daowow_core::redemption::prize_obligation_key(&ticket, &source);
        let absence = host.absence_proof(&[key]).unwrap();
        let amount = (i as u64 + 1) * SHANNONS;
        state = state
            .record_verified_prize(&source, amount, &absence)
            .unwrap();
        host.insert(
            &key,
            &daowow_core::redemption::prize_payment_leaf(&ticket, &source, amount),
        )
        .unwrap();
    }
    let type_script = world.claim_type_script(shard_id, position);
    let cell = CellOutputBuilder::default()
        .capacity(pack_u64(claim_cell_capacity(lock)))
        .lock(lock.clone())
        .type_(Some(type_script).pack())
        .build();
    let op = world
        .context
        .create_cell(cell, Bytes::from(state.encode().to_vec()));
    (op, args)
}

/// Retire `claim_op` (a fully paid winner) with no successor, minting its
/// memento at `round.winning_shard/position` under `lock`. Mirrors the
/// accepted non-winner retirement shape, adding the memento output the
/// claim's own script requires of a winner.
pub fn retire_with_memento(
    world: &mut World,
    round: &SealedRound,
    lock: &Script,
    claim_op: OutPoint,
    args: &daowow_core::claim::ClaimArgs,
) -> TransactionView {
    let (_, claim_data) = world.cell(&claim_op);
    let state = daowow_core::redemption::PrizeRedemptionState::decode(&claim_data).unwrap();
    let memento_type = world.memento_type_script(args.shard_id, args.position);
    let memento_data = daowow_core::memento::MementoData {
        renderer_version: daowow_core::memento::MEMENTO_RENDERER_V1,
        prize_index: round.prize_index,
        paid_count: state.paid_count(),
        paid_total: state.paid_total(),
    }
    .encode();
    TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(claim_op).build())
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(memento_cell_capacity(lock)))
                .lock(lock.clone())
                .type_(Some(memento_type).pack())
                .build(),
        )
        .output_data(pack_pbytes(&memento_data))
        .cell_dep(round.config_dep.clone())
        .cell_dep(round.entropy_dep.clone())
        .witness(schedule_witness(&round.schedule))
        .build()
}

/// A live memento cell under `lock`, independent of any retiring claim.
/// Transfer/burn exercise only the memento's own group (content correctness
/// against a draw is the claim script's job, proven by `retire_with_memento`).
pub fn seed_memento(world: &mut World, lock: &Script, round: &SealedRound) -> OutPoint {
    let memento_type = world.memento_type_script(round.winning_shard, round.winning_position);
    let data = daowow_core::memento::MementoData {
        renderer_version: daowow_core::memento::MEMENTO_RENDERER_V1,
        prize_index: round.prize_index,
        paid_count: 1,
        paid_total: SHANNONS,
    }
    .encode();
    let cell = CellOutputBuilder::default()
        .capacity(pack_u64(memento_cell_capacity(lock)))
        .lock(lock.clone())
        .type_(Some(memento_type).pack())
        .build();
    world.context.create_cell(cell, Bytes::from(data.to_vec()))
}

/// Transfer `memento_op` under `lock`, keeping its data byte-identical (the
/// memento's only transfer requirement; ownership authorization is the
/// cell's separate lock script, not this type script).
pub fn transfer_memento(world: &mut World, lock: &Script, memento_op: OutPoint) -> TransactionView {
    let (cell, data) = world.cell(&memento_op);
    TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(memento_op).build())
        .output(cell.as_builder().lock(lock.clone()).build())
        .output_data(data.pack())
        .build()
}

/// Burn `memento_op`: consume with no successor, recovering its capacity to
/// a plain cell. Free — a memento carries no rights to discharge.
pub fn burn_memento(world: &mut World, memento_op: OutPoint) -> TransactionView {
    let (cell, _) = world.cell(&memento_op);
    let capacity: u64 = cell.capacity().unpack();
    let (_, plain_lock) = world.always_success();
    TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(memento_op).build())
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(capacity))
                .lock(plain_lock)
                .build(),
        )
        .output_data(Bytes::new().pack())
        .build()
}

pub fn expect_fail(context: &mut Context, tx: &TransactionView) -> ckb_testtool::ckb_error::Error {
    let tx = context.complete_tx(tx.clone());
    match context.verify_tx(&tx, MAX_CYCLES) {
        Ok(_) => panic!("tx should fail but passed:\n{}", hex_tx(&tx)),
        Err(e) => e,
    }
}

pub fn hex_tx(tx: &TransactionView) -> String {
    // serialize the transaction for debugging
    let v = migraph_hex(tx.data().as_bytes());
    v
}

fn migraph_hex(b: impl AsRef<[u8]>) -> String {
    b.as_ref().iter().map(|x| format!("{:02x}", x)).collect()
}
