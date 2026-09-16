//! Claim NFT sub-project 2: rejected redemption cases on CKB-VM.
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
type Owned = (u32, u32, u64, u64, Vec<u8>, Vec<u8>);

fn build_redeem(fx: &mut Fx, which: &[usize], pay_to: Option<Script>, final_drain: bool) -> Built {
    build_redeem_with(fx, which, pay_to, final_drain, &mut |_, _| {})
}

/// `tweak` runs on the sorted witness items and the outputs before encoding.
fn build_redeem_with(
    fx: &mut Fx,
    which: &[usize],
    pay_to: Option<Script>,
    final_drain: bool,
    tweak: &mut dyn FnMut(&mut Vec<Owned>, &mut Vec<(CellOutput, Bytes)>),
) -> Built {
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
    let mut owned: Vec<Owned> = Vec::new();
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
    tweak(&mut owned, &mut outputs);
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
#[allow(dead_code)]
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
#[allow(dead_code)]
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
#[allow(dead_code)]
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

const PRIZES: [u64; 3] = [400 * SHANNONS, 300 * SHANNONS, 900 * SHANNONS];
const SETTLE_DATA: &str = "-71";
const SETTLE_CONSERVATION: &str = "-72";
const SETTLE_PROOF: &str = "-73";
const SETTLE_CURSOR: &str = "-74";
const SETTLE_REDEEM: &str = "-77";
const CLAIM_TRANSITION: &str = "-95";
const CLAIM_RETIRE: &str = "-96";
const CLAIM_REDEEM: &str = "-97";
const CLAIM_UNIVERSE: &str = "-98";

fn code_of(err: &ckb_testtool::ckb_error::Error) -> String {
    let text = format!("{err}");
    text.split("error code ")
        .nth(1)
        .and_then(|rest| rest.split(' ').next())
        .unwrap_or("?")
        .to_string()
}

fn expect_code(fx: &mut Fx, tx: &TransactionView, codes: &[&str]) {
    let err = expect_fail(&mut fx.w.context, tx);
    let code = code_of(&err);
    assert!(codes.contains(&code.as_str()), "unexpected failure: {err}");
}

#[test]
fn replaying_a_committed_redemption_is_rejected() {
    let mut fx = fixture(&PRIZES, false);
    let built = build_redeem(&mut fx, &[0], None, false);
    expect_ok(&mut fx.w.context, &built.tx);
    chain_cell(&mut fx.w, &fx.funding, &built.tx, 0);
    let op = fx.claims[0].op.clone();
    chain_cell(&mut fx.w, &op, &built.tx, built.claim_outputs[0]);
    // same bytes against the advanced cells: funding counters no longer match
    expect_code(&mut fx, &built.tx, &[SETTLE_REDEEM]);
}

#[test]
fn redeeming_the_same_source_twice_is_rejected_by_the_claim() {
    // a fresh transaction whose funding side is consistent, but the claim's
    // paid set already contains this source: stale absence proof -> claim
    let mut fx = fixture(&PRIZES, false);
    let first = build_redeem(&mut fx, &[0], None, false);
    expect_ok(&mut fx.w.context, &first.tx);
    chain_cell(&mut fx.w, &fx.funding, &first.tx, 0);
    fx.funding_data = first.after;
    let op = fx.claims[0].op.clone();
    chain_cell(&mut fx.w, &op, &first.tx, first.claim_outputs[0]);
    // rebuild the claim's host as if unpaid so the builder produces a proof
    // against the OLD root; the successor state is then forged by counters
    let stale_absence = {
        let fresh = SmtHost::new();
        let source = prize_source(&fx.cfg.commitment(), BATCH, &DIGEST);
        fresh
            .absence_proof(&[prize_obligation_key(
                &fx.claims[0].args.ticket_id(),
                &source,
            )])
            .unwrap()
    };
    let (claim_cell, claim_data) = fx.w.cell(&fx.claims[0].op);
    let paid_once = PrizeRedemptionState::decode(&claim_data).unwrap();
    let mut forged = paid_once.encode();
    forged[65..73].copy_from_slice(&2u64.to_le_bytes());
    forged[73..81].copy_from_slice(&(paid_once.paid_total() * 2).to_le_bytes());
    let (funding_cell, _) = fx.w.cell(&fx.funding);
    let in_cap: u64 = funding_cell.capacity().unpack();
    let amount = fx.claims[0].amount;
    let mut after = fx.funding_data;
    after.prize_paid += amount;
    let item = RedemptionItem {
        claim_input_index: 2,
        payment_output_index: 2,
        prize_index: fx.claims[0].prize_index,
        amount,
        mmr_proof: &fx
            .prizes
            .membership_proof(fx.claims[0].prize_index)
            .unwrap(),
        absence_proof: &stale_absence,
    };
    let (sponsor, sponsor_lock) = fx.w.funding_cell(1_000 * SHANNONS);
    let tx = TransactionBuilder::default()
        .cell_dep(fx.w.round_config_dep(&fx.round))
        .input(CellInput::new(fx.funding.clone(), 0))
        .input(CellInput::new(sponsor, 0))
        .input(CellInput::new(fx.claims[0].op.clone(), 0))
        .witness(redemption_witness(&[item]))
        .output(
            funding_cell
                .as_builder()
                .capacity(pack_u64(in_cap - amount))
                .build(),
        )
        .output_data(Bytes::from(after.encode().to_vec()).pack())
        .output(claim_cell.clone())
        .output_data(Bytes::from(forged.to_vec()).pack())
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(amount))
                .lock(claim_cell.lock())
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
    // the forged successor even satisfies the settlement's counter check;
    // only the claim's SMT absence proof against its real root can refuse
    expect_code(&mut fx, &tx, &[CLAIM_REDEEM]);
}

#[test]
fn unchanged_claim_successor_cannot_collect_a_prize() {
    // the identical-data successor would pass the claim script as a transfer
    let mut fx = fixture(&PRIZES, false);
    let built = build_redeem_with(&mut fx, &[0], None, false, &mut |_, outputs| {
        let (cell, _) = outputs[1].clone();
        let args = daowow_core::claim::ClaimArgs::decode(
            &cell.type_().to_opt().unwrap().args().raw_data(),
        )
        .unwrap();
        outputs[1].1 = Bytes::from(daowow_core::claim::initial_state_bytes(&args).to_vec());
    });
    expect_code(&mut fx, &built.tx, &[SETTLE_REDEEM]);
}

#[test]
fn payment_to_a_stranger_is_rejected() {
    let mut fx = fixture(&PRIZES, false);
    let (_, stranger) = fx.w.always_success();
    let stranger = stranger.as_builder().args(pack_pbytes(b"mallory")).build();
    let built = build_redeem(&mut fx, &[0], Some(stranger), false);
    expect_code(&mut fx, &built.tx, &[SETTLE_REDEEM]);
}

#[test]
fn wrong_amount_is_rejected() {
    // the claim side is kept consistent with the inflated amount so that only
    // the settlement's prize-tree membership can reject
    let mut fx = fixture(&PRIZES, false);
    let source = prize_source(&fx.cfg.commitment(), BATCH, &DIGEST);
    let (_, claim_data) = fx.w.cell(&fx.claims[0].op);
    let ticket = fx.claims[0].args.ticket_id();
    let inflated = fx.claims[0].amount + 1;
    let built = build_redeem_with(&mut fx, &[0], None, false, &mut |items, outputs| {
        items[0].3 = inflated;
        let fresh = SmtHost::new();
        let absence = fresh
            .absence_proof(&[prize_obligation_key(&ticket, &source)])
            .unwrap();
        let state = PrizeRedemptionState::decode(&claim_data).unwrap();
        let next = state
            .record_verified_prize(&source, inflated, &absence)
            .unwrap();
        items[0].5 = absence;
        outputs[1].1 = Bytes::from(next.encode().to_vec());
        let idx = items[0].1 as usize;
        let (cell, data) = outputs[idx].clone();
        outputs[idx] = (cell.as_builder().capacity(pack_u64(inflated)).build(), data);
    });
    expect_code(&mut fx, &built.tx, &[SETTLE_PROOF]);
}

#[test]
fn wrong_prize_index_is_rejected() {
    let mut fx = fixture(&PRIZES, false);
    let built = build_redeem_with(&mut fx, &[0], None, false, &mut |items, _| {
        items[0].2 = (items[0].2 + 1) % 3;
    });
    expect_code(&mut fx, &built.tx, &[SETTLE_PROOF]);
}

#[test]
fn forged_membership_proof_is_rejected() {
    let mut fx = fixture(&PRIZES, false);
    let built = build_redeem_with(&mut fx, &[0], None, false, &mut |items, _| {
        let last = items[0].4.len() - 1;
        items[0].4[last] ^= 1;
    });
    expect_code(&mut fx, &built.tx, &[SETTLE_PROOF]);
}

#[test]
fn corrupt_absence_proof_is_rejected_by_the_claim() {
    let mut fx = fixture(&PRIZES, false);
    let built = build_redeem_with(&mut fx, &[0], None, false, &mut |items, _| {
        items[0].5[0] ^= 1;
    });
    expect_code(&mut fx, &built.tx, &[CLAIM_REDEEM]);
}

#[test]
fn missing_claim_successor_is_rejected() {
    let mut fx = fixture(&PRIZES, false);
    let built = build_redeem_with(&mut fx, &[0], None, false, &mut |items, outputs| {
        // drop the claim successor; move the payment index down by one
        outputs.remove(1);
        items[0].1 -= 1;
    });
    // With no successor, the claim's own script now attempts a real
    // retirement and fails at the sealed-round evidence lookup (no entropy
    // record or schedule witness is offered) rather than the old
    // unconditional refusal; script-hash execution order decides which of
    // the two failing groups (settlement or claim) reports first.
    expect_code(
        &mut fx,
        &built.tx,
        &[SETTLE_REDEEM, CLAIM_RETIRE, CLAIM_UNIVERSE],
    );
}

#[test]
fn claim_update_without_the_funding_input_is_rejected() {
    let mut fx = fixture(&PRIZES, false);
    let built = build_redeem(&mut fx, &[0], None, false);
    let (cell, _) = fx.w.cell(&fx.claims[0].op);
    let new_data = built.tx.outputs_data().get(built.claim_outputs[0]).unwrap();
    let (sponsor, _) = fx.w.funding_cell(1_000 * SHANNONS);
    let tx = TransactionBuilder::default()
        .cell_dep(fx.w.round_config_dep(&fx.round))
        .input(CellInput::new(sponsor, 0))
        .input(CellInput::new(fx.claims[0].op.clone(), 0))
        .output(cell)
        .output_data(new_data)
        .build();
    expect_code(&mut fx, &tx, &[CLAIM_REDEEM]);
}

#[test]
fn funding_prize_paid_cannot_advance_on_the_payout_path() {
    let mut fx = fixture(&PRIZES, true);
    let (funding_cell, _) = fx.w.cell(&fx.funding);
    let in_cap: u64 = funding_cell.capacity().unpack();
    let mut after = fx.funding_data;
    after.payout_cursor = 1;
    after.prize_paid = fx.claims[0].amount; // no claim redeemed anything
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
    let (sponsor, _) = fx.w.funding_cell(1_000 * SHANNONS);
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
        .build();
    expect_code(&mut fx, &tx, &[SETTLE_CURSOR]);
}

#[test]
fn funding_prize_paid_cannot_advance_without_a_claim_input() {
    // no claim cell in the transaction at all: only the settlement runs
    let mut fx = fixture(&PRIZES, false);
    let (funding_cell, _) = fx.w.cell(&fx.funding);
    let in_cap: u64 = funding_cell.capacity().unpack();
    let amount = fx.claims[0].amount;
    let mut after = fx.funding_data;
    after.prize_paid += amount;
    let mmr_proof = fx
        .prizes
        .membership_proof(fx.claims[0].prize_index)
        .unwrap();
    let item = RedemptionItem {
        claim_input_index: 2, // does not exist
        payment_output_index: 1,
        prize_index: fx.claims[0].prize_index,
        amount,
        mmr_proof: &mmr_proof,
        absence_proof: &[0u8; 8],
    };
    let (sponsor, _) = fx.w.funding_cell(1_000 * SHANNONS);
    let holder = fx.claims[0].lock.clone();
    let tx = TransactionBuilder::default()
        .cell_dep(fx.w.round_config_dep(&fx.round))
        .input(CellInput::new(fx.funding.clone(), 0))
        .input(CellInput::new(sponsor, 0))
        .witness(redemption_witness(&[item]))
        .output(
            funding_cell
                .as_builder()
                .capacity(pack_u64(in_cap - amount))
                .build(),
        )
        .output_data(Bytes::from(after.encode().to_vec()).pack())
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(amount))
                .lock(holder)
                .build(),
        )
        .output_data(Bytes::new().pack())
        .build();
    expect_code(&mut fx, &tx, &[SETTLE_REDEEM]);
}

#[test]
fn two_items_sharing_a_payment_output_are_rejected() {
    let mut fx = fixture(&PRIZES, false);
    let mut by_amount: Vec<usize> = (0..fx.claims.len()).collect();
    by_amount.sort_by_key(|i| fx.claims[*i].amount);
    let which = [by_amount[0], by_amount[1]];
    let built = build_redeem_with(&mut fx, &which, None, false, &mut |items, _| {
        items[1].1 = items[0].1;
    });
    expect_code(&mut fx, &built.tx, &[SETTLE_REDEEM]);
}

#[test]
fn lock_change_inside_a_redemption_is_rejected() {
    let mut fx = fixture(&PRIZES, false);
    let (_, other) = fx.w.always_success();
    let other = other.as_builder().args(pack_pbytes(b"other")).build();
    let built = build_redeem_with(&mut fx, &[0], None, false, &mut |_, outputs| {
        let (cell, data) = outputs[1].clone();
        outputs[1] = (cell.as_builder().lock(other.clone()).build(), data);
    });
    expect_code(&mut fx, &built.tx, &[CLAIM_TRANSITION]);
}

#[test]
fn final_drain_with_prizes_unpaid_is_rejected() {
    let mut fx = fixture(&PRIZES, false);
    let built = build_redeem(&mut fx, &[0], None, true);
    // conservation fails first: the cell still holds the other prizes
    expect_code(&mut fx, &built.tx, &[SETTLE_CONSERVATION, SETTLE_REDEEM]);
}

#[test]
fn final_drain_with_principal_unpaid_is_rejected() {
    let mut fx = fixture(&PRIZES, true);
    let which: Vec<usize> = (0..3).collect();
    let built = build_redeem(&mut fx, &which, None, true);
    expect_code(&mut fx, &built.tx, &[SETTLE_CONSERVATION, SETTLE_REDEEM]);
}

#[test]
fn payout_final_with_prizes_unpaid_is_rejected() {
    let mut fx = fixture(&PRIZES, true);
    let (funding_cell, _) = fx.w.cell(&fx.funding);
    let in_cap: u64 = funding_cell.capacity().unpack();
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
    let (sponsor, _) = fx.w.funding_cell(1_000 * SHANNONS);
    // pay the whole cell to the depositor with no successor
    let tx = TransactionBuilder::default()
        .cell_dep(fx.w.round_config_dep(&fx.round))
        .input(CellInput::new(fx.funding.clone(), 0))
        .input(CellInput::new(sponsor, 0))
        .witness(pack_pbytes(&witness))
        .output(
            CellOutputBuilder::default()
                .capacity(pack_u64(in_cap))
                .lock(fx.depositor.clone())
                .build(),
        )
        .output_data(Bytes::new().pack())
        .build();
    expect_code(&mut fx, &tx, &[SETTLE_CONSERVATION, SETTLE_REDEEM]);
}

#[test]
fn redemption_witness_on_a_prizeless_batch_is_rejected() {
    let mut fx = fixture(&PRIZES, false);
    let mut data = fx.funding_data;
    data.prize_count = 0;
    data.prize_root = [0; 32];
    let (cell, _) = fx.w.cell(&fx.funding);
    fx.w.context.create_cell_with_out_point(
        fx.funding.clone(),
        cell,
        Bytes::from(data.encode().to_vec()),
    );
    fx.funding_data = data;
    let built = build_redeem(&mut fx, &[0], None, false);
    expect_code(&mut fx, &built.tx, &[SETTLE_REDEEM, SETTLE_DATA]);
}

#[test]
fn items_out_of_prize_order_are_rejected_by_the_settlement_only() {
    // both claim scripts find their own item regardless of order, so only the
    // settlement's strict prize-index ordering can reject this transaction
    let mut fx = fixture(&PRIZES, false);
    let mut by_amount: Vec<usize> = (0..fx.claims.len()).collect();
    by_amount.sort_by_key(|i| fx.claims[*i].amount);
    let which = [by_amount[0], by_amount[1]];
    let built = build_redeem_with(&mut fx, &which, None, false, &mut |items, _| {
        items.reverse();
    });
    expect_code(&mut fx, &built.tx, &[SETTLE_REDEEM]);
}

#[test]
fn two_items_naming_the_same_claim_input_are_rejected() {
    let mut fx = fixture(&PRIZES, false);
    let mut by_amount: Vec<usize> = (0..fx.claims.len()).collect();
    by_amount.sort_by_key(|i| fx.claims[*i].amount);
    let which = [by_amount[0], by_amount[1]];
    let built = build_redeem_with(&mut fx, &which, None, false, &mut |items, _| {
        items[1].0 = items[0].0;
    });
    // the settlement's dedup and the second claim's "not named" check both
    // refuse; which reports first depends on script-hash order
    expect_code(&mut fx, &built.tx, &[SETTLE_REDEEM, CLAIM_REDEEM]);
}

#[test]
fn zero_amount_item_is_rejected() {
    let mut fx = fixture(&PRIZES, false);
    let built = build_redeem_with(&mut fx, &[0], None, false, &mut |items, _| {
        items[0].3 = 0;
    });
    // settlement rejects amount 0 before any proof; the claim rejects it in
    // record_verified_prize. Either code proves no zero-value marker is paid.
    expect_code(&mut fx, &built.tx, &[SETTLE_REDEEM, CLAIM_REDEEM]);
}

#[test]
fn forged_paid_root_in_the_successor_is_rejected_by_the_claim_only() {
    // counters advance exactly and the root differs, so the settlement's
    // successor check passes; only the claim's byte-exact recomputation of
    // its successor can refuse a root that the absence proof did not produce
    let mut fx = fixture(&PRIZES, false);
    let built = build_redeem_with(&mut fx, &[0], None, false, &mut |_, outputs| {
        let mut data = outputs[1].1.to_vec();
        data[40] ^= 1; // inside paid_root (bytes 33..65)
        outputs[1].1 = Bytes::from(data);
    });
    expect_code(&mut fx, &built.tx, &[CLAIM_REDEEM]);
}
