// headless full-round engine test — mirrors the on-chain proto suites:
// deterministic draw, exact shannon conservation, adversarial rejections.
"use strict";

const { Engine } = require("../engine.js");

const e = new Engine({ name: "demo", ticketPriceCkb: 100, shards: 4, minTickets: 5, keeperFeeCkb: 5, yieldPercent: 2 });
e.createRound();
const names = ["alice", "bob", "carol", "dave", "erin", "frank", "grace", "heidi"];
for (const n of names) e.addParticipant(n, 3 + (names.indexOf(n) % 4), "secret-" + n);
for (const n of names) e.enter(n);
e.freeze();
e.aggregate(3);
e.finalizeEntropy(["aa".repeat(32), "bb".repeat(32), "cc".repeat(32)].map((h) => Buffer.from(h, "hex")));
const winners = e.draw();
console.log("winners:", winners.map((w) => w.prizeIndex + ":" + w.name + "@" + w.position).join(" "));
e.daoWithdraw();
e.settle();

// deterministic draw reproduction is covered by core vector tests
// (drawSeed + rejection sampling); here we check accounting and adversarials.

const c = e.conservation;
console.log("conservation:", JSON.stringify({
  realized: c.realized.toString(), principal: c.principal.toString(),
  prizes: c.prizes.toString(), occupiedReserve: c.occupiedReserve.toString(),
  keeperFee: c.keeperFee.toString(), txFees: c.txFees.toString(), residual: c.residual.toString(),
}));
const sum = c.principal + c.prizes + c.occupiedReserve + c.keeperFee + c.txFees + c.residual;
if (sum !== c.realized) {
  console.log("CONSERVATION BROKEN", sum.toString(), "!=", c.realized.toString());
  process.exit(1);
}
// every aggregated participant got principal back exactly
const price = 100n * 100_000_000n;
for (const [n, t] of names.map((n, i) => [n, BigInt(3 + (i % 4))])) {
  const po = e.payouts.find((p) => p.name === n);
  if (!po || po.principal !== price * t) {
    console.log("PRINCIPAL NOT RETURNED for", n, po && po.principal.toString());
    process.exit(1);
  }
}
// prize pool = compensation - keeper - fees; winners share it
const prizeSum = e.payouts.reduce((a, p) => a + p.prize, 0n);
if (prizeSum + e.prizeDust !== c.prizes) {
  console.log("PRIZE POOL MISMATCH", prizeSum.toString(), e.prizeDust.toString(), c.prizes.toString());
  process.exit(1);
}

for (const [n, f] of [
  ["forge", () => e.attemptForgeRoot("alice")],
  ["dup", () => e.attemptDoublePayout("alice")],
  ["op", () => e.attemptPayoutToOperator()],
  ["sub", () => e.attemptPhase1Substitution()],
]) {
  try {
    f();
    console.log("ADVERSARIAL FAIL:", n);
    process.exit(1);
  } catch (err) { /* expected, mirrored on-chain code */ }
}
console.log("ENGINE OK");
