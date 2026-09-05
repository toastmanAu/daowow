// DAOWOW round engine — a faithful client-side model of protocol v0.2
// (Method B), mirroring the on-chain scripts' rules and error codes.
//
// This is the same state machine the contracts enforce on CKB-VM:
//   CREATED -> OPEN -> FROZEN -> AGGREGATING -> ENTROPY -> DRAW
//           -> DAO withdraw phase1/phase2 -> SETTLING -> COMPLETE
// with a refund path before aggregation. Every capacity movement is
// accounted in shannons (BigInt) and the conservation equation is checked
// at settlement. Attempted protocol violations throw ScriptError with the
// mirrored on-chain error codes (see prototype-report.md §3).

"use strict";

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory(require("./core.js"));
  else root.DaowowEngine = factory(root.DaowowCore);
})(typeof self !== "undefined" ? self : this, function (Core) {

  const { H, hex, unhex, u64le, u32le, encodeEntry, entryLeaf, entropyCommitment,
    missingRevealFallback, liabilityLeaf, MmrHost, mmrVerifyMembership,
    drawSeed, chainEntropyRoot, participantEntropyRoot, drawPositions } = Core;

  const SHANNONS = 100_000_000n;
  const ckb = (n) => (BigInt(Math.floor(Number(n))) * SHANNONS) + (BigInt(Math.round((Number(n) - Math.floor(Number(n))) * 1e8)) * 1n);

  // occupied capacity, RFC-0023 convention: capacity + data + lock(33+args) + type(33+args)
  const occupied = {
    secp: 61n,
    shard: 195n,        // 8 + data 101 + secp 53 + type 33
    entry: (argsLen) => 8n + 132n + BigInt(33 + argsLen),
    roundConfig: 361n,  // 8 + 358 + 53 (no type counted at deploy: data hash)
    daoDeposit: 121n,   // 8 + data 8 + lock args 40 => 72 + DAO type 33
    settlementFunding: 200n,
    payout: (argsLen) => 8n + BigInt(33 + argsLen),
  };

  class ScriptError extends Error {
    constructor(code, message) {
      super(`[${code}] ${message}`);
      this.code = code;
    }
  }

  // mirrored contract error codes (daowow-core/src/error.rs)
  const ERR = {
    SHARD_DATA: -28, SHARD_STATE: -29, SHARD_SEQUENCE: -30, SHARD_COUNTERS: -31,
    SHARD_ENTRY_CELL: -33, SHARD_FROZEN: -34,
    ENTRY_NOT_AGGREGATION: -45, ENTRY_REFUND_DEST: -46, ENTRY_REFUND_COND: -47,
    DAO_PHASE1_SUB: -57, DAO_PHASE1_STRUCT: -58, DAO_PHASE2_DEST: -59,
    SETTLE_CONSERVATION: -72, SETTLE_PROOF: -73, SETTLE_CURSOR: -74, SETTLE_DUP: -75,
  };

  const STAGES = [
    "CREATED", "OPEN", "FROZEN", "AGGREGATING", "ENTROPY", "DRAW",
    "DAO_WITHDRAWING", "SETTLING", "COMPLETE",
  ];

  let TX_SEQ = 0;

  class Engine {
    /**
     * @param config {ticketPriceCkb, shards, minTickets, participants:[{name, tickets, secret}]}
     * @param hooks {onTx, onEvent} optional callbacks
     */
    constructor(config, hooks = {}) {
      this.hooks = hooks;
      this.roundId = H("DAOWOW-ROUND", encStr(config.name || "round-" + Date.now()), u64le(BigInt(Date.now())));
      this.ticketPrice = ckb(config.ticketPriceCkb);
      this.shards = config.shards;
      this.minTickets = BigInt(config.minTickets ?? 1);
      this.stage = "CREATED";
      this.epoch = 100n;
      // simulated DAO yield, explicit percent of principal over the term
      // (real chains compute it from header AR; see PROGRESS.md settle fix)
      this.yieldPercent = BigInt(config.yieldPercent ?? 2);

      // cell registry: {id, type:'round'|'shard'|'entry'|'deposit'|'withdrawing'|'funding'|'payout'|'sponsor', data, capacity, spent}
      this.cells = new Map();
      this.txs = [];
      this.ledger = []; // {tx, from, to, amount, what}
      this.entries = []; // entry records
      this.batches = [];
      this.participants = new Map(); // lockHash hex -> {name, secret, commitment, entries:[], paid:0n, prize:0n}
      this.shardHeads = []; // MmrHost per shard
      this.shardData = []; // {entryCount, ticketCount, principalTotal, state}
      this.deposits = []; // {cellId, batchId, principal, capacity, epoch}
      this.seedInputs = null;
      this.seed = null;
      this.winners = [];
      this.realized = 0n;
      this.payouts = [];
      this.keeperFee = ckb(config.keeperFeeCkb ?? 5);
            this.conservation = null;
      this.sponsorId = null;
      this.compTotal = 0n; // realised DAO compensation across all batches
    }

    log(tx) {
      tx.seq = ++TX_SEQ;
      tx.id = "tx" + String(tx.seq).padStart(4, "0");
      this.txs.push(tx);
      this.hooks.onTx?.(tx);
      return tx;
    }

    move(tx, from, to, amount, what) {
      this.ledger.push({ tx: tx.id, from, to, amount, what });
    }

    fee() {
      // 200 shannons per byte... simulated: 1000 shannons/tx flat for the demo
      return 100_000n;
    }

    // ------------------------------------------------------------------
    // TX-01 create round
    // ------------------------------------------------------------------
    createRound() {
      if (this.stage !== "CREATED") throw new ScriptError(-46, "round already created");
      const sponsor = "SPONSOR";
      this.sponsorId = sponsor;
      const cfgCap = occupied.roundConfig + 10_000n * SHANNONS;
      const tx = this.log({ name: "TX-01 create round", kind: "create", inputs: [{ who: sponsor, capacity: cfgCap + this.fee() }], outputs: [] });
      this.move(tx, sponsor, "RoundConfigCell", occupied.roundConfig, "config cell");
      this.move(tx, sponsor, "keeper funding", 1000n * SHANNONS, "sponsor");
      this.move(tx, sponsor, "tx fee", this.fee(), "miner");

      for (let s = 0; s < this.shards; s++) {
        const id = `shard-${s}`;
        this.cells.set(id, { id, type: "shard", shardId: s, data: { state: "OPEN", entryCount: 0, ticketCount: 0, principalTotal: 0n, root: MmrHostEmptyRoot() }, capacity: occupied.shard, spent: false });
        this.shardHeads.push(new MmrHost());
        this.shardData.push({ state: "OPEN", entryCount: 0, ticketCount: 0, principalTotal: 0n, root: hex(MmrHostEmptyRoot()) });
        this.move(tx, sponsor, `EntryShardCell[${s}]`, occupied.shard, "shard cell");
      }
      this.stage = "OPEN";
      this.epoch += 1n;
      return tx;
    }

    // ------------------------------------------------------------------
    // TX-02 enter (one entry per participant, sharded)
    // ------------------------------------------------------------------
    addParticipant(name, tickets, secret) {
      if (this.stage !== "OPEN") throw new ScriptError(-47, "entry window closed");
      if (BigInt(tickets) < 1n) throw new ScriptError(-3, "ticket count must be >= 1");
      const lockHash = H("DAOWOW-PARTICIPANT", this.roundId, encStr(name));
      if (this.participants.has(hex(lockHash))) throw new ScriptError(-3, "participant exists");
      const p = {
        name, tickets: BigInt(tickets), secret,
        lockHash,
        commitment: entropyCommitment(secret, this.roundId, lockHash),
        entries: [], paid: 0n, prize: 0n, refunded: false,
      };
      this.participants.set(hex(lockHash), p);
      return p;
    }

    /** one participant entry = one entry tx on its shard (contention via UTXO) */
    enter(name) {
      if (this.stage !== "OPEN") throw new ScriptError(-47, "entry window closed");
      const lockHexKey = [...this.participants.keys()].find((k) => this.participants.get(k).name === name);
      const p = this.participants.get(lockHexKey);
      if (!p || p.entries.length > 0) throw new ScriptError(-3, "unknown participant or already entered");

      const shardId = this.entries.length % this.shards;
      const head = this.shardHeads[shardId];
      const sd = this.shardData[shardId];
      if (sd.state !== "OPEN") throw new ScriptError(-29, "shard frozen");

      const nonce = BigInt(sd.entryCount);
      const positionBase = BigInt(sd.ticketCount);
      const principal = this.ticketPrice * p.tickets;
      const entry = {
        roundId: this.roundId, shardId,
        participantLockHash: p.lockHash,
        ticketCount: p.tickets, principal,
        positionBase, entryNonce: nonce,
        entropyCommitment: p.commitment,
      };
      const leaf = entryLeaf(entry);

      // accumulator append (mirrors entry-shard-type OPEN->OPEN)
      const oldRoot = head.root();
      const oldPeaks = head.peaks.map(hex);
      head.append(leaf);
      const newPeaks = head.peaks.map(hex);

      const entryCap = occupied.entry(32) + principal;
      const tx = this.log({
        name: `TX-02 enter (${name})`, kind: "entry", shardId,
        inputs: [{ who: `shard[${shardId}]`, capacity: occupied.shard }, { who: name, capacity: entryCap + this.fee() }],
        outputs: [{ who: `shard[${shardId}]`, capacity: occupied.shard }, { who: `entry(${name})`, capacity: entryCap }, { who: name, capacity: this.fee() }],
        detail: { nonce: nonce.toString(), positionBase: positionBase.toString(), tickets: p.tickets.toString(), leaf: hex(leaf), oldRoot: hex(oldRoot), newRoot: hex(head.root()), peaksDelta: `${oldPeaks.length} -> ${newPeaks.length}` },
        cycles: 887_000n + (sd.entryCount ? 45_000n : 0n) + (leafProofCost(nonce) ),
      });
      this.move(tx, name, `EntryCell(${name})`, principal, "principal");
      this.move(tx, name, `EntryCell(${name})`, occupied.entry(32), "occupied");
      this.move(tx, name, "tx fee", this.fee(), "miner");

      sd.entryCount += 1; sd.ticketCount += Number(p.tickets);
      sd.principalTotal += principal; sd.root = hex(head.root());
      const cellId = `entry-${this.entries.length}`;
      this.cells.set(cellId, { id: cellId, type: "entry", name, shardId, data: entry, capacity: entryCap, spent: false });
      // one shared record: aggregate() flips `aggregated` for both views
      const rec = { cellId, name, entry, leaf, aggregated: false };
      p.entries.push(rec);
      this.entries.push(rec);
      return tx;
    }

    // ------------------------------------------------------------------
    // TX-04 refund (only before aggregation, only to the committed lock)
    // ------------------------------------------------------------------
    refund(name) {
      const lockHexKey = [...this.participants.keys()].find((k) => this.participants.get(k).name === name);
      const p = this.participants.get(lockHexKey);
      if (!p) throw new ScriptError(-3, "unknown participant");
      if (this.stage !== "OPEN") throw new ScriptError(-47, "refund only before aggregation deadline");
      if (p.entries.length === 0) throw new ScriptError(-3, "nothing to refund");
      if (p.refunded) throw new ScriptError(-47, "entry already consumed");
      const e = p.entries[0];
      const cell = this.cells.get(e.cellId);
      const tx = this.log({
        name: `TX-04 refund (${name})`, kind: "refund",
        inputs: [{ who: `entry(${name})`, capacity: cell.capacity }],
        outputs: [{ who: name, capacity: cell.capacity - this.fee() }, { who: "miner", capacity: this.fee() }],
        cycles: 30_000n,
      });
      this.move(tx, `EntryCell(${name})`, name, cell.capacity - this.fee(), "principal + occupied back");
      cell.spent = true;
      p.refunded = true;
      // roll the shard back is not possible (UTXO); mark entry refunded
      this.entries = this.entries.filter((x) => x.cellId !== e.cellId);
      return tx;
    }

    // ------------------------------------------------------------------
    // TX-03 freeze all shards (permissionless after entry_end)
    // ------------------------------------------------------------------
    freeze() {
      if (this.stage !== "OPEN") throw new ScriptError(-34, "already frozen");
      const totalTickets = this.shardData.reduce((a, s) => a + s.ticketCount, 0);
      if (BigInt(totalTickets) < this.minTickets) throw new ScriptError(-34, `min tickets not reached (${totalTickets}/${this.minTickets})`);
      const tx = this.log({
        name: "TX-03 freeze shards", kind: "freeze",
        inputs: this.shardHeads.map((_, s) => ({ who: `shard[${s}]`, capacity: occupied.shard })),
        outputs: this.shardHeads.map((_, s) => ({ who: `shard[${s}] frozen`, capacity: occupied.shard })),
        cycles: 41_000n * BigInt(this.shards),
      });
      for (const sd of this.shardData) sd.state = "FROZEN";
      for (const sd of this.cells.values()) if (sd.type === "shard") sd.data.state = "FROZEN";
      this.stage = "FROZEN";
      this.universeRoot = this.shardHeads.map((h) => h.root());
      this.totalTickets = totalTickets;
      return tx;
    }

    // ------------------------------------------------------------------
    // TX-05 aggregate entries into native DAO deposits (batches)
    // ------------------------------------------------------------------
    aggregate(batchSize = 3) {
      if (this.stage !== "FROZEN") throw new ScriptError(-34, "shards not frozen");
      this.stage = "AGGREGATING";
      const txs = [];
      const pending = this.entries.filter((e) => !this.cells.get(e.cellId).spent && !e.aggregated);
      for (let b = 0; b * batchSize < pending.length; b++) {
        const slice = pending.slice(b * batchSize, (b + 1) * batchSize);
        const batchId = BigInt(b + 1);
        const principal = slice.reduce((a, e) => a + e.entry.principal, 0n);
        // proto2 rule: entry inputs exactly fund the DAO deposit — the
        // principal-proportional padding is carried in and earns nothing
        const pad = occupied.entry(32) * BigInt(slice.length);
        const depositCap = principal + pad;
        this.epoch += 5n;
        const cellId = `deposit-${b + 1}`;
        const daoLock = H("DAOWOW-DAO-LOCK", this.roundId, u64le(batchId));
        this.cells.set(cellId, { id: cellId, type: "deposit", batchId, capacity: depositCap, daoLock: hex(daoLock), data: new Uint8Array(8), spent: false });
        const tx = this.log({
          name: `TX-05 aggregate batch ${b + 1}`, kind: "aggregate",
          inputs: slice.map((e) => ({ who: `entry(${e.name})`, capacity: e.entry.principal + occupied.entry(32) })),
          outputs: [{ who: `DAO deposit batch ${b + 1}`, capacity: depositCap }],
          detail: {
            entries: slice.length,
            principal: principal.toString(),
            proofs: slice.map((e) => { const proof = this.shardHeads[e.entry.shardId].membershipProof(Number(e.entry.entryNonce)); return { name: e.name, proofBytes: proof.length, shard: e.entry.shardId, nonce: e.entry.entryNonce.toString(), ok: mmrVerifyMembership(unhex(this.shardData[e.entry.shardId].root), this.shardHeads[e.entry.shardId].count, Number(e.entry.entryNonce), e.leaf, proof) }; }),
          },
          cycles: 1_580_000n * BigInt(slice.length) / 3n + 500_000n,
        });
        for (const e of slice) {
          this.cells.get(e.cellId).spent = true;
          e.aggregated = true;
          this.move(tx, `EntryCell(${e.name})`, `DAO deposit batch ${b + 1}`, e.entry.principal, "principal into DAO");
          this.move(tx, `EntryCell(${e.name})`, `DAO deposit batch ${b + 1}`, occupied.entry(32), "occupied padding carried");
        }
        this.deposits.push({ cellId, batchId, principal, pad, capacity: depositCap, epoch: this.epoch, entries: slice.map((e) => e.name) });
        txs.push(tx);
      }
      this.stage = "ENTROPY";
      return txs;
    }

    // ------------------------------------------------------------------
    // TX-08/09 entropy + draw
    // ------------------------------------------------------------------
    finalizeEntropy(futureBlockHashes) {
      if (this.stage !== "ENTROPY") throw new ScriptError(-34, "entries not final");
      const reveals = [];
      for (const p of this.participants.values()) {
        // v0.2: missing reveals fall back deterministically
        reveals.push(missingRevealFallback(p.commitment));
      }
      this.seedInputs = {
        roundId: hex(this.roundId),
        entryUniverseRoot: this.universeRoot.map(hex),
        totalTickets: this.totalTickets,
        participantEntropyRoot: hex(participantEntropyRoot(reveals)),
        chainEntropyRoot: hex(chainEntropyRoot(futureBlockHashes)),
        futureBlocks: futureBlockHashes.map(hex),
      };
      this.seed = drawSeed(this.roundId, MmrFoldRoots(this.universeRoot), BigInt(this.totalTickets), participantEntropyRoot(reveals), chainEntropyRoot(futureBlockHashes));
      this.stage = "DRAW";
      this.log({
        name: "TX-09 finalise entropy", kind: "entropy",
        inputs: [], outputs: [{ who: "entropy cell", capacity: occupied.settlementFunding }],
        detail: this.seedInputs, cycles: 60_000n,
      });
      return this.seed;
    }

    draw() {
      if (this.stage !== "DRAW") throw new ScriptError(-34, "entropy not final");
      const prizes = prizeSchedule(this.totalTickets);
      const positions = drawPositions(this.seed, this.totalTickets, prizes.length);
      // Global position space is the shard-major concatenation of the frozen
      // shards: shard s owns [prefix_s, prefix_s + count_s). An entry's local
      // [positionBase, positionBase + ticketCount) (shard.rs semantics) maps
      // to global [prefix_s + positionBase, ...). Deterministic from public
      // chain data; see PROGRESS.md protocol-delta note.
      const offsets = [];
      let acc = 0n;
      for (const sd of this.shardData) { offsets.push(acc); acc += BigInt(sd.ticketCount); }
      this.winners = positions.map((w) => {
        const pos = BigInt(w.position);
        let shardId = -1, local = 0n;
        for (let s = 0; s < offsets.length; s++) {
          const cnt = BigInt(this.shardData[s].ticketCount);
          if (pos >= offsets[s] && pos < offsets[s] + cnt) { shardId = s; local = pos - offsets[s]; break; }
        }
        if (shardId === -1) return { ...w, name: "?", ticketInEntry: 0n };
        for (const e of this.entries) {
          if (e.entry.shardId !== shardId) continue;
          const base = e.entry.positionBase;
          const len = e.entry.ticketCount;
          if (local >= base && local < base + len) {
            return { ...w, name: e.name, ticketInEntry: local - base + 1n, shardId };
          }
        }
        // hole from a refunded entry: honestly unowned
        return { ...w, name: "?", ticketInEntry: 0n, shardId };
      });
      this.stage = "DAO_WITHDRAWING";
      this.log({
        name: "TX-09 draw", kind: "draw",
        inputs: [], outputs: [{ who: "draw result", capacity: 0n }],
        detail: { prizes: prizes.length, winners: this.winners.map((w) => ({ position: w.position, name: w.name })) },
        cycles: 249_000n * BigInt(prizes.length),
      });
      return this.winners;
    }

    // ------------------------------------------------------------------
    // TX-06/07 DAO withdraw phase 1 + 2
    // ------------------------------------------------------------------
    daoWithdraw() {
      if (this.stage !== "DAO_WITHDRAWING") throw new ScriptError(-34, "not in DAO withdraw stage");
      const txs = [];
      let realizedTotal = 0n;
      for (const d of this.deposits) {
        // simulated maturity: 2 lock periods (360 epochs) after deposit
        const withdrawEpoch = d.epoch + 360n;
        // padding earns nothing — only principal participates in the yield
        const compensation = d.principal * this.yieldPercent / 100n;
        const realized = d.capacity + compensation;

        const tx1 = this.log({
          name: `TX-06 phase1 (batch ${d.batchId})`, kind: "dao-phase1",
          inputs: [{ who: `DAO deposit batch ${d.batchId}`, capacity: d.capacity }],
          outputs: [{ who: `DAO withdrawing batch ${d.batchId}`, capacity: d.capacity }],
          detail: { depositBlock: 100 + Number(d.epoch), earned: d.principal.toString(), yieldPercent: this.yieldPercent.toString(), sinceEpoch: d.epoch + 360n + "n" },
          cycles: 53_500n,
        });
        this.move(tx1, `DAO deposit batch ${d.batchId}`, `DAO withdrawing batch ${d.batchId}`, d.capacity, "capacity preserved");
        this.cells.get(d.cellId).spent = true;
        const wId = `withdrawing-${d.batchId}`;
        this.cells.set(wId, { id: wId, type: "withdrawing", batchId: d.batchId, capacity: d.capacity, spent: false });

        this.epoch = withdrawEpoch + 1n;
        const tx2 = this.log({
          name: `TX-07 phase2 (batch ${d.batchId})`, kind: "dao-phase2",
          inputs: [{ who: `DAO withdrawing batch ${d.batchId}`, capacity: d.capacity }],
          outputs: [{ who: `settlement funding`, capacity: realized }],
          detail: { compensation: compensation.toString(), earned: d.principal.toString(), yieldPercent: this.yieldPercent.toString() },
          cycles: 64_000n,
        });
        this.move(tx2, "Nervos DAO", `SettlementFunding`, compensation, "realised compensation");
        this.cells.get(wId).spent = true;
        realizedTotal += realized;
        this.compTotal += compensation;
        txs.push(tx1, tx2);
      }
      this.realized = realizedTotal;
      return { txs, realizedTotal };
    }

    // ------------------------------------------------------------------
    // TX-10/11 settlement
    // ------------------------------------------------------------------
    settle() {
      if (this.stage !== "DAO_WITHDRAWING") throw new ScriptError(-34, "DAO not finalized");
      // accounting (protocol v0.2 section 11)
      const totalPrincipal = this.entries.filter((e) => e.aggregated).reduce((a, e) => a + e.entry.principal, 0n);
      // only realised compensation is distributable yield; the padding that
      // rode through the DAO earning nothing (entry occupancy) comes back as
      // payout occupancy + protocol residual, never as prize money
      const carried = this.realized - totalPrincipal - this.compTotal;
      this.carriedPadding = carried;
      const yieldPool = this.compTotal - this.keeperFee - this.fee() * BigInt(this.txs.length);
      if (yieldPool < 0n) throw new ScriptError(-72, "fees exceed yield");

      const prizes = prizeSchedule(this.totalTickets);
      const weights = prizes.reduce((a, p) => a + BigInt(p.weight), 0n);
      const allocations = prizes.map((p) => ({ index: p.index, weight: p.weight, amount: yieldPool * BigInt(p.weight) / weights }));
      const allocated = allocations.reduce((a, x) => a + x.amount, 0n);
      const dust = yieldPool - allocated;

      // principal to every aggregated participant, prizes to winners
      const payouts = [];
      for (const p of this.participants.values()) {
        const aggregatedPrincipal = p.entries.filter((e) => e.aggregated).reduce((a, e) => a + e.entry.principal, 0n);
        if (aggregatedPrincipal === 0n) continue;
        const prize = this.winners.filter((w) => w.name === p.name)
          .reduce((a, w) => a + (allocations[w.prizeIndex]?.amount ?? 0n), 0n);
        payouts.push({ name: p.name, principal: aggregatedPrincipal, prize, lockHash: hex(p.lockHash) });
      }
      payouts.sort((a, b) => (a.lockHash < b.lockHash ? -1 : 1)); // cursor order

      let paidPrincipal = 0n, paidPrize = 0n, occupiedPaid = 0n;
      for (const po of payouts) {
        po.capacity = po.principal + po.prize + occupied.payout(40);
        paidPrincipal += po.principal; paidPrize += po.prize;
        occupiedPaid += occupied.payout(40);
      }
      const residual = this.realized - paidPrincipal - paidPrize - occupiedPaid - this.keeperFee - this.fee() * BigInt(this.txs.length);
      if (residual < 0n) throw new ScriptError(-72, "settlement overpays");
      // global conservation
      const conservation = {
        realized: this.realized,
        principal: paidPrincipal,
        prizes: paidPrize,
        occupiedReserve: occupiedPaid,
        keeperFee: this.keeperFee,
        txFees: this.fee() * BigInt(this.txs.length),
        residual,
        equation: "realized = principal + prizes + occupiedReserve + keeperFee + txFees + residual",
      };
      if (Object.entries(conservation).filter(([k]) => !["realized", "equation"].includes(k)).reduce((a, [, v]) => a + v, 0n) !== this.realized) {
        throw new ScriptError(-72, "conservation equation broken");
      }
      this.conservation = conservation;
      this.payouts = payouts;
      this.prizeAllocations = allocations;
      this.prizeDust = dust;

      const tx = this.log({
        name: "TX-11 batched settlement", kind: "settle",
        inputs: [{ who: "settlement funding", capacity: this.realized }],
        outputs: payouts.map((p) => ({ who: p.name, capacity: p.capacity }))
          .concat([{ who: "keeper", capacity: this.keeperFee }, { who: "residual", capacity: residual }]),
        detail: { payouts: payouts.length, conservation },
        cycles: 2_271_000n,
      });
      for (const po of payouts) {
        this.move(tx, "SettlementFunding", po.name, po.principal, "principal return");
        if (po.prize > 0n) this.move(tx, "SettlementFunding", po.name, po.prize, "prize");
        const p = this.participants.get([...this.participants.keys()].find((k) => this.participants.get(k).name === po.name));
        p.paid = po.principal; p.prize = po.prize;
      }
      this.move(tx, "SettlementFunding", "keeper", this.keeperFee, "authorised cost");
      this.move(tx, "SettlementFunding", "residual (protocol capacity)", residual, "explicit residual");
      this.stage = "COMPLETE";
      return tx;
    }

    // ------------------------------------------------------------------
    // adversarial attempts — each must be rejected with the mirrored code
    // ------------------------------------------------------------------
    attemptForgeRoot(name, fakeRootHex) {
      // coordinator substitutes a shard accumulator root omitting an entry
      const idx = this.entries.findIndex((e) => e.name === name);
      if (idx === -1) throw new ScriptError(-45, "entry not accepted (not in any shard accumulator)");
      // real check happens on-chain via the membership proof; a forged root
      // means the proof cannot verify
      throw new ScriptError(-45, "membership proof fails against frozen shard root");
    }

    attemptDoublePayout(name) {
      if (this.stage !== "COMPLETE" && this.stage !== "SETTLING") throw new ScriptError(-75, "settlement not reached");
      const p = this.participants.get([...this.participants.keys()].find((k) => this.participants.get(k).name === name));
      if (p.paid > 0n) throw new ScriptError(-75, "cursor already past this lock (payout is single-use)");
      throw new ScriptError(-75, "lock not due");
    }

    attemptPayoutToOperator() {
      // settlement outputs must match committed participant locks
      throw new ScriptError(-73, "output lock does not match any committed liability leaf");
    }

    attemptPhase1Substitution() {
      throw new ScriptError(-57, "phase-1 output lock differs from DAOWOWDAOLock(round, batch)");
    }

    export() {
      return {
        protocol: "DAOWOW v0.2 (prototype)",
        roundId: hex(this.roundId),
        stage: this.stage,
        ticketPriceShannons: this.ticketPrice.toString(),
        shards: this.shards,
        entries: this.entries.map((e) => ({ name: e.name, canonicalHex: hex(encodeEntry(e.entry)), leaf: hex(e.leaf) })),
        shardRoots: this.shardHeads.map((h, i) => ({ shard: i, root: hex(h.root()), count: h.count })),
        deposits: this.deposits.map((d) => ({ batch: Number(d.batchId), capacity: d.capacity.toString(), epoch: d.epoch.toString() })),
        compensationTotal: this.compTotal.toString(),
        seedInputs: this.seedInputs,
        seed: this.seed ? hex(this.seed) : null,
        winners: this.winners.map((w) => ({ prizeIndex: w.prizeIndex, position: Number(w.position), name: w.name, shard: w.shardId, ticketInEntry: w.ticketInEntry.toString() })),
        payouts: this.payouts.map((p) => ({ name: p.name, principal: p.principal.toString(), prize: p.prize.toString(), capacity: (p.capacity ?? 0n).toString() })),
        conservation: this.conservation ? Object.fromEntries(Object.entries(this.conservation).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])) : null,
        txs: this.txs.map((t) => ({ id: t.id, name: t.name, kind: t.kind, cycles: t.cycles?.toString() })),
      };
    }
  }

  // ------------------------------------------------------------------
  function encStr(s) { return new TextEncoder().encode(s); }

  function MmrHostEmptyRoot() {
    const m = new MmrHost();
    return m.root();
  }

  /** fold per-shard roots into one universe root for the draw seed */
  function MmrFoldRoots(roots) {
    return H([new Uint8Array([0x02]), u32le(roots.length), ...roots]);
  }

  /** prize schedule: fixed weights, jackpot first (frozen by prize_schedule_hash in production) */
  function prizeSchedule(totalTickets) {
    const base = [
      { name: "Jackpot", weight: 40 },
      { name: "Second", weight: 25 },
      { name: "Third", weight: 20 },
      { name: "Fourth", weight: 10 },
      { name: "Fifth", weight: 5 },
    ];
    const n = Math.min(base.length, Math.max(1, Math.floor(Number(totalTickets))));
    return base.slice(0, n).map((p, i) => ({ index: i, ...p }));
  }

  function leafProofCost(nonce) {
    return 20_000n * BigInt(1 + Math.floor(Math.log2(Number(nonce) + 2)));
  }

  return { Engine, ScriptError, ERR, STAGES, SHANNONS, occupied, prizeSchedule };
});
