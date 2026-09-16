//! Claim NFT sub-project 2: accepted redemption cases on CKB-VM.
//! Spec: docs/superpowers/specs/2026-09-16-prize-redemption-design.md
//!
//! The funding cell is seeded with a real prize tree over real claim
//! identities; DAO provenance of the funding cell has its own suites.

mod common;

use ckb_testtool::ckb_types::{
    bytes::Bytes,
    core::{TransactionBuilder, TransactionView},
    packed::*,
    prelude::*,
};
use common::*;
use daowow_core::accumulator::{mmr::host::MmrHost, smt::host::SmtHost};
use daowow_core::encoding::{PayoutItem, RoundConfigV1, SettlementFundingDataV3, ACC_SMT};
use daowow_core::redemption::{
    prize_obligation_key, prize_payment_leaf, prize_source, PrizeRedemptionState,
};
use daowow_core::witness::RedemptionItem;

const BATCH: u64 = 1;
const DIGEST: [u8; 32] = [0xD1; 32];
const PRINCIPAL: u64 = 100 * SHANNONS;

struct Claim {
    op: OutPoint,
    args: daowow_core::claim::ClaimArgs,
    amount: u64,
    prize_index: u64,
    lock: Script,
    paid: SmtHost,
}

struct Fx {
    w: World,
    cfg: RoundConfigV1,
    round: OutPoint,
    funding: OutPoint,
    funding_data: SettlementFundingDataV3,
    prizes: MmrHost,
    claims: Vec<Claim>,
    depositor: Script,
    liabilities: MmrHost,
}

/// One batch whose prize domain is `amounts` for tickets (shard 0, i), one
/// depositor liability of PRINCIPAL already paid unless `cursor_open`.
fn fixture(amounts: &[u64], cursor_open: bool) -> Fx {
    let mut w = World::new(ACC_SMT);
    let cfg = default_config([0x51; 32], ACC_SMT);
    let round = w.create_round(&cfg);
    let cfg = full_config(&cfg, &w.deps);
    let mut items: Vec<(daowow_core::claim::ClaimArgs, u64)> = amounts
        .iter()
        .enumerate()
        .map(|(i, a)| {
            (
                daowow_core::claim::ClaimArgs {
                    commitment: cfg.commitment(),
                    shard_id: 0,
                    position: i as u64,
                },
                *a,
            )
        })
        .collect();
    items.sort_by_key(|(args, _)| args.ticket_id());
    let mut prizes = MmrHost::new();
    for (args, amount) in &items {
        prizes
            .append(&daowow_core::leaf::prize_leaf(&args.ticket_id(), *amount))
            .unwrap();
    }
    let prize_pool: u64 = amounts.iter().sum();
    let (_, depositor) = w.always_success();
    let depositor = depositor
        .as_builder()
        .args(pack_pbytes(b"depositor"))
        .build();
    let depositor_hash = World::participant_hash(&depositor);
    let mut liabilities = MmrHost::new();
    liabilities
        .append(&daowow_core::leaf::liability_leaf(
            &depositor_hash,
            PRINCIPAL,
            0,
        ))
        .unwrap();
    let funding_data = SettlementFundingDataV3 {
        round_id: cfg.round_id,
        batch_id: BATCH,
        realized_total: PRINCIPAL + prize_pool,
        principal_liability: PRINCIPAL,
        prize_pool,
        payout_cursor: if cursor_open { 0 } else { 1 },
        liability_count: 1,
        liabilities_root: liabilities.root().unwrap(),
        prize_count: items.len() as u64,
        prize_root: prizes.root().unwrap(),
        prize_paid: 0,
    };
    let capacity = if cursor_open {
        PRINCIPAL + prize_pool
    } else {
        prize_pool
    };
    let type_script = w.settlement_script_with_digest(BATCH, &DIGEST);
    let lock = w.settlement_public_lock();
    let funding = w.context.create_cell(
        CellOutputBuilder::default()
            .capacity(pack_u64(capacity))
            .lock(lock)
            .type_(Some(type_script).pack())
            .build(),
        Bytes::from(funding_data.encode().to_vec()),
    );
    let (_, holder) = w.always_success();
    let holder = holder.as_builder().args(pack_pbytes(b"holder")).build();
    let mut claims = Vec::new();
    for (index, (args, amount)) in items.iter().enumerate() {
        let (op, _) = seed_claim(&mut w, &holder, 0, args.position);
        claims.push(Claim {
            op,
            args: *args,
            amount: *amount,
            prize_index: index as u64,
            lock: holder.clone(),
            paid: SmtHost::new(),
        });
    }
    Fx {
        w,
        cfg,
        round,
        funding,
        funding_data,
        prizes,
        claims,
        depositor,
        liabilities,
    }
}

struct Built {
    tx: TransactionView,
    after: SettlementFundingDataV3,
    /// output index of each redeemed claim's successor, in `which` order
    claim_outputs: Vec<usize>,
}

/// Redeem `which` claims in one transaction. `pay_to` overrides the payment
/// lock (None = each claim's own lock). Updates each claim's paid-set host as
/// if the transaction succeeds; callers of rejected shapes discard the fixture.
fn build_redeem(fx: &mut Fx, which: &[usize], pay_to: Option<Script>, final_drain: bool) -> Built {
    let (funding_cell, _) = fx.w.cell(&fx.funding);
    let in_cap: u64 = funding_cell.capacity().unpack();
    let total: u64 = which.iter().map(|i| fx.claims[*i].amount).sum();
    let mut after = fx.funding_data;
    after.prize_paid += total;
    let (sponsor, sponsor_lock) = fx.w.funding_cell(1_000 * SHANNONS);
    let mut b = TransactionBuilder::default()
        .cell_dep(fx.w.round_config_dep(&fx.round))
        .input(CellInput::new(fx.funding.clone(), 0))
        .input(CellInput::new(sponsor, 0));
    let mut outputs: Vec<(CellOutput, Bytes)> = Vec::new();
    if !final_drain {
        outputs.push((
            funding_cell
                .as_builder()
                .capacity(pack_u64(in_cap - total))
                .build(),
            Bytes::from(after.encode().to_vec()),
        ));
    }
    let source = prize_source(&fx.cfg.commitment(), BATCH, &DIGEST);
    let mut owned: Vec<(u32, u32, u64, u64, Vec<u8>, Vec<u8>)> = Vec::new();
    let mut claim_outputs = Vec::new();
    for (k, i) in which.iter().enumerate() {
        let claim_input_index = 2 + k as u32;
        b = b.input(CellInput::new(fx.claims[*i].op.clone(), 0));
        let (cell, data) = fx.w.cell(&fx.claims[*i].op);
        let claim = &mut fx.claims[*i];
        let key = prize_obligation_key(&claim.args.ticket_id(), &source);
        let absence = claim.paid.absence_proof(&[key]).unwrap();
        let state = PrizeRedemptionState::decode(&data).unwrap();
        let next = state
            .record_verified_prize(&source, claim.amount, &absence)
            .unwrap();
        claim
            .paid
            .insert(
                &key,
                &prize_payment_leaf(&claim.args.ticket_id(), &source, claim.amount),
            )
            .unwrap();
        claim_outputs.push(outputs.len());
        outputs.push((cell.clone(), Bytes::from(next.encode().to_vec())));
        let payee = pay_to.clone().unwrap_or(claim.lock.clone());
        let payment_output_index = outputs.len() as u32;
        outputs.push((
            CellOutputBuilder::default()
                .capacity(pack_u64(claim.amount))
                .lock(payee)
                .build(),
            Bytes::new(),
        ));
        owned.push((
            claim_input_index,
            payment_output_index,
            claim.prize_index,
            claim.amount,
            fx.prizes.membership_proof(claim.prize_index).unwrap(),
            absence,
        ));
    }
    owned.sort_by_key(|o| o.2);
    let items: Vec<RedemptionItem> = owned
        .iter()
        .map(|(c, p, x, a, m, ab)| RedemptionItem {
            claim_input_index: *c,
            payment_output_index: *p,
            prize_index: *x,
            amount: *a,
            mmr_proof: m,
            absence_proof: ab,
        })
        .collect();
    b = b.witness(redemption_witness(&items));
    for (cell, data) in outputs {
        b = b.output(cell).output_data(data.pack());
    }
    let tx = b
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(900 * SHANNONS))
                .lock(sponsor_lock)
                .build(),
        )
        .output_data(Bytes::new().pack())
        .build();
    Built {
        tx,
        after,
        claim_outputs,
    }
}

/// Run a redemption and chain the funding cell and redeemed claims forward.
fn redeem(fx: &mut Fx, which: &[usize], final_drain: bool) -> u64 {
    let built = build_redeem(fx, which, None, final_drain);
    let cycles = expect_ok(&mut fx.w.context, &built.tx);
    if !final_drain {
        chain_cell(&mut fx.w, &fx.funding, &built.tx, 0);
        fx.funding_data = built.after;
    }
    for (k, i) in which.iter().enumerate() {
        let op = fx.claims[*i].op.clone();
        chain_cell(&mut fx.w, &op, &built.tx, built.claim_outputs[k]);
    }
    cycles
}

/// Pay the single principal liability to the depositor (non-final).
fn pay_principal(fx: &mut Fx) {
    let (funding_cell, _) = fx.w.cell(&fx.funding);
    let in_cap: u64 = funding_cell.capacity().unpack();
    let mut after = fx.funding_data;
    after.payout_cursor = 1;
    let item = PayoutItem {
        participant_lock_hash: World::participant_hash(&fx.depositor),
        principal: PRINCIPAL,
        prize: 0,
    };
    let proof = fx.liabilities.membership_proof(0).unwrap();
    let args = fx.depositor.args().raw_data();
    let code = fx.depositor.code_hash().raw_data();
    let witness = daowow_core::witness::encode_settlement_witness(&[(
        args.as_ref(),
        code.as_ref(),
        u8::from(fx.depositor.hash_type()),
        &item,
        proof.as_slice(),
    )]);
    let (sponsor, sponsor_lock) = fx.w.funding_cell(1_000 * SHANNONS);
    let tx = TransactionBuilder::default()
        .cell_dep(fx.w.round_config_dep(&fx.round))
        .input(CellInput::new(fx.funding.clone(), 0))
        .input(CellInput::new(sponsor, 0))
        .witness(pack_pbytes(&witness))
        .output(
            funding_cell
                .as_builder()
                .capacity(pack_u64(in_cap - PRINCIPAL))
                .build(),
        )
        .output_data(Bytes::from(after.encode().to_vec()).pack())
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(PRINCIPAL))
                .lock(fx.depositor.clone())
                .build(),
        )
        .output_data(Bytes::new().pack())
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(900 * SHANNONS))
                .lock(sponsor_lock)
                .build(),
        )
        .output_data(Bytes::new().pack())
        .build();
    expect_ok(&mut fx.w.context, &tx);
    chain_cell(&mut fx.w, &fx.funding, &tx, 0);
    fx.funding_data = after;
}

/// Transfer claim `i` to `to` (byte-identical data), chaining it forward.
fn transfer(fx: &mut Fx, i: usize, to: &Script) {
    let (funding, _) = fx.w.funding_cell(1_000 * SHANNONS);
    let (cell, data) = fx.w.cell(&fx.claims[i].op);
    let tx = TransactionBuilder::default()
        .input(CellInput::new(funding, 0))
        .input(CellInput::new(fx.claims[i].op.clone(), 0))
        .output(cell.as_builder().lock(to.clone()).build())
        .output_data(data.pack())
        .build();
    expect_ok(&mut fx.w.context, &tx);
    let op = fx.claims[i].op.clone();
    chain_cell(&mut fx.w, &op, &tx, 0);
    fx.claims[i].lock = to.clone();
}

/// A funding successor must keep at least its own occupied capacity (about
/// 307 CKB), so fixtures leave a third prize unpaid until the final drain.
const PRIZES: [u64; 3] = [400 * SHANNONS, 300 * SHANNONS, 900 * SHANNONS];

#[test]
fn one_claim_redeems_its_prize() {
    let mut fx = fixture(&PRIZES, false);
    let cycles = redeem(&mut fx, &[0], false);
    println!("one-claim redemption cycles: {cycles}");
    assert_eq!(fx.funding_data.prize_paid, fx.claims[0].amount);
    let (_, data) = fx.w.cell(&fx.claims[0].op);
    let state = PrizeRedemptionState::decode(&data).unwrap();
    assert_eq!(state.paid_count(), 1);
    assert_eq!(state.paid_total(), fx.claims[0].amount);
}

#[test]
fn two_claims_redeem_in_one_transaction() {
    let mut fx = fixture(&PRIZES, false);
    // claims are in ticket-id order; redeem the two smallest so the
    // funding successor keeps the largest prize above its occupied floor
    let mut by_amount: Vec<usize> = (0..fx.claims.len()).collect();
    by_amount.sort_by_key(|i| fx.claims[*i].amount);
    let which = [by_amount[1], by_amount[0]];
    let cycles = redeem(&mut fx, &which, false);
    println!("two-claim redemption cycles: {cycles}");
    assert_eq!(fx.funding_data.prize_paid, 700 * SHANNONS);
}

#[test]
fn transferred_claim_redeems_into_new_holder_lock() {
    let mut fx = fixture(&PRIZES, false);
    let (_, bob) = fx.w.always_success();
    let bob = bob.as_builder().args(pack_pbytes(b"bob")).build();
    transfer(&mut fx, 0, &bob);
    let built = build_redeem(&mut fx, &[0], None, false);
    expect_ok(&mut fx.w.context, &built.tx);
    // payment output follows the claim successor and is locked to bob
    let payment = built.tx.outputs().get(built.claim_outputs[0] + 1).unwrap();
    assert_eq!(payment.lock().as_slice(), bob.as_slice());
    assert_eq!(
        Unpack::<u64>::unpack(&payment.capacity()),
        fx.claims[0].amount
    );
}

#[test]
fn principal_payout_then_redemptions_then_final_drain() {
    let mut fx = fixture(&PRIZES, true);
    pay_principal(&mut fx);
    assert_eq!(fx.funding_data.payout_cursor, 1);
    redeem(&mut fx, &[0], false);
    // the last prizes drain the cell: no funding output, capacity fully paid
    let built = build_redeem(&mut fx, &[1, 2], None, true);
    let cycles = expect_ok(&mut fx.w.context, &built.tx);
    println!("final-drain redemption cycles: {cycles}");
    assert!(built.tx.outputs().into_iter().all(|o| o
        .type_()
        .to_opt()
        .map(|t| t.args().raw_data().len())
        != Some(72)));
}

#[test]
fn max_items_redemption_fits_cycle_budget() {
    let amounts = vec![50 * SHANNONS; daowow_core::witness::MAX_REDEMPTION_ITEMS];
    let mut fx = fixture(&amounts, false);
    let which: Vec<usize> = (0..amounts.len()).collect();
    let cycles = redeem(&mut fx, &which, true);
    println!(
        "{}-claim redemption cycles: {cycles}",
        daowow_core::witness::MAX_REDEMPTION_ITEMS
    );
    assert!(cycles < MAX_CYCLES);
}
