"use strict";
// Wrapped in an IIFE: loaded as a classic script these files share one
// global scope, so top-level declarations would collide between modules.
(function () {
// Every sentence a player reads outside the How it works tab.
//
// Kept in one pure file so the no-jargon rule is enforced by a test: none of
// the protocol's own words (the banned list is in ../../test/model-copy.test.js)
// may appear in anything this file can say. Time is in hours and days, rounds
// have friendly names, and money is in CKB.

const roundState = () =>
  typeof require === "function" ? require("./round-state.js") : window.DaowowRoundState;
const ticketsLib = () =>
  typeof require === "function" ? require("./tickets.js") : window.DaowowTickets;
const time = () =>
  typeof require === "function" ? require("./time.js") : window.DaowowTime;
const entropyDerive = () => typeof require === "function"
  ? require("../../chain/entropy-derive.js") : window.DaowowEntropyDerive;

const SHANNONS = 100000000n;
const grouped = (n) => BigInt(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** Whole CKB, rounded DOWN: a figure the player is owed is never overstated. */
function ckb(shannons) {
  return grouped(BigInt(shannons) / SHANNONS);
}

function ordinal(n) {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${{ 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th"}`;
}

const plural = (n, word) => `${n} ${word}${BigInt(n) === 1n ? "" : "s"}`;

function shortAddress(address) {
  const a = String(address);
  return a.length <= 14 ? a : `${a.slice(0, 6)}…${a.slice(-6)}`;
}

function stateBadge(state, view) {
  const S = roundState().PLAYER_STATE;
  return {
    [S.UPCOMING]: "Opens soon",
    [S.OPEN]: view && view.full ? "Full" : "Open now",
    [S.WAITING]: "Waiting for draw",
    [S.DRAWN]: "Drawn",
    [S.REFUNDS]: "Didn't fill · refunds open",
    [S.FINISHED]: "Finished",
  }[state];
}

function ticketsLine(sold, cap) {
  return cap === null || cap === undefined
    ? `${plural(sold, "ticket")} sold`
    : `${sold} of ${cap} tickets sold`;
}

/** The next thing that happens to a round, and roughly when. */
function milestone({ view, snapshot, tip }) {
  const S = roundState().PLAYER_STATE;
  const t = time();
  const until = (epoch) => t.describeDuration(t.msUntilEpoch(epoch, tip.epoch));
  switch (view.state) {
    case S.UPCOMING: return `Opens in ${until(snapshot.config.entryStart)}`;
    case S.OPEN: return `Closes in ${until(snapshot.config.entryEnd)}`;
    case S.WAITING: {
      if (!snapshot.seal) return "Entries are closed. The draw comes next.";
      const last = entropyDerive().lastEntropyHeight(snapshot.seal.inclusionHeight);
      return `Draw in ${t.describeDuration(t.msUntilBlock(last, tip.height))}`;
    }
    case S.DRAWN: return "Winners are drawn. Prizes are paid after the savings term.";
    case S.REFUNDS: return "This round didn't get enough tickets. Deposits can be taken back.";
    default: return "This round is over.";
  }
}

function outcomeBadge(outcome) {
  const O = ticketsLib().OUTCOME;
  return {
    [O.IN_ROUND]: "In the round",
    [O.WAITING]: "Waiting for draw",
    [O.REFUNDABLE]: "Refund ready",
    [O.REFUND_LATER]: "Refund opens soon",
    [O.DID_NOT_RUN]: "Round didn't run",
    [O.WON]: "You won",
    [O.NOT_THIS_TIME]: "Not this time",
  }[outcome];
}

function actionLabel(action) {
  const A = ticketsLib().ACTION;
  return {
    [A.ENTER_MORE]: "Enter more",
    [A.REFUND]: "Refund",
    [A.WATCH_DRAW]: "Watch the draw",
    [A.CLAIM_SOON]: "Prize claiming opens soon",
    [A.RETIRE_SOON]: "Your ticket deposit will be returnable here soon",
  }[action] ?? "";
}

function estimateLine(shannons) {
  const whole = BigInt(shannons) / SHANNONS;
  return whole === 0n
    ? "under 1 CKB so far, still growing"
    : `about ${grouped(whole)} CKB so far, still growing`;
}

const honestyLine = (height) =>
  `This result was fixed on-chain at block ${grouped(height)}. The animation only reveals it.`;

const winLine = (place, weight, total) =>
  `${ordinal(place)} place · ${weight} of ${total} shares of the prize pool`;

const heldLine = (n) => `You hold ${plural(n, "ticket")}`;

// What entering costs, each part with what happens to it afterwards.
const costTicket = (price) =>
  `${ckb(price)} CKB per ticket. You get this back after the round, win or lose.`;
const costDeposit = (amount, connected) =>
  `${ckb(amount)} CKB ticket deposit per ticket${connected ? "" : " with a JoyID wallet"}. ` +
  "Held while the round runs, then returned.";
const costStorage = (amount) =>
  `${ckb(amount)} CKB storage deposit, once per purchase. Returned after the round.`;
const costExample = (total) =>
  `Buying one ticket moves ${ckb(total)} CKB out of your wallet. All of it comes back except the fee.`;
const placeLine = (place, share, opensAt, open, reachable) => {
  const head = `${ordinal(place)} place · ${share} shares`;
  if (!reachable) return `${head} · not available in a round this size`;
  return open ? `${head} · paying` : `${head} · opens at ${opensAt} tickets`;
};
const poolLine = (shannons) => `Prize pool: ${estimateLine(shannons)}`;

const enterFor = (total) => `Enter for ${total} CKB`;
const entryConfirmed = (n) => `Confirmed. Your ${plural(n, "ticket")} ${BigInt(n) === 1n ? "is" : "are"} in the round.`;
const ticketsLeft = (left) =>
  `Only ${plural(left, "ticket")} ${BigInt(left) === 1n ? "is" : "are"} left in this round.`;
const heldFor = (termText) => `until payout, ${termText} after the draw`;

const refundButton = (shannons) => `Refund ${ckb(shannons)} CKB`;
const refundReturns = (shannons) => `${ckb(shannons)} CKB returns to your wallet.`;
const refundDone = (shannons) => `Refunded. ${ckb(shannons)} CKB is back in your wallet.`;

const resultLine = (place, ticketLabel, mine) =>
  `${ordinal(place)} place — Ticket ${ticketLabel}${mine ? " (yours)" : ""}`;
const drawCountdown = (height, ms) =>
  `The result is fixed when block ${grouped(height)} is mined, in ${time().describeDuration(ms)}.`;

const errors = Object.freeze({
  network: "We can't reach the network right now. Check your connection and try again.",
  lagging: "The network is catching up, so what you see here may be a little old. Try again in a moment.",
  drawChanged: "This round's result changed on the network after it was shown, so it has been taken down. Check back in a few minutes.",
  manifest: "This site couldn't load its own settings. Reload the page to try again.",
  roundNotFound: "We couldn't find that round.",
  wallet: (message) => `The wallet didn't connect: ${message}. Nothing was sent. Please try again.`,
  mine: "We couldn't load your tickets. Try again in a moment.",
  schedule: "This round's prize table couldn't be checked, so entering is switched off.",
  draw: "This round's result couldn't be confirmed against the network, so it isn't shown. Try again later.",
  multiShard: "This round's result can't be shown in this view yet.",
  noWebgl: "The animation can't run on this device, so here is the result as a list.",
});

const text = Object.freeze({
  retry: "Try again",
  dismiss: "Dismiss",
  loading: "Loading…",
  connect: "Connect wallet",
  connecting: "Connecting…",
  disconnect: "Disconnect",
  connectPrompt: "Connect your wallet to see your tickets.",
  noTickets: "No tickets yet. Pick a round to get started.",
  noRounds: "No rounds yet. Check back soon.",
  seeRounds: "See rounds",
  enter: "Enter",
  enterCurrent: "Enter the current round",
  notOpen: "The current round isn't open for entries right now.",
  details: "Details",
  technical: "Technical details",
  roundId: "Round id",
  testnet: "Testnet. These are test coins with no real value.",
  groups: Object.freeze({
    open: "Open now", upcoming: "Upcoming", waiting: "Waiting for draw", finished: "Finished",
  }),
  entry: Object.freeze({
    title: "Enter",
    tickets: "How many tickets?",
    summary: "What leaves your wallet",
    agree: "I understand this total is held until the round pays out.",
    acceptLate: "I understand this entry may not arrive in time.",
    connectToEnter: "Connect wallet to enter",
    checking: "Checking the round…",
    approve: "Approve in your wallet…",
    sending: "Sending…",
    waiting: "Sent. Waiting for confirmation…",
    stillWaiting: "This is taking longer than usual. Your entry may still go through. Check My tickets in a few minutes.",
    notSent: "Your entry was not sent. Nothing has left your wallet.",
    rejected: "The network turned this entry down. Nothing has left your wallet.",
    pending: "Your entry was sent, but we couldn't confirm it yet. Don't send it again. Check My tickets in a few minutes.",
    sentElsewhere: "Your entry was sent after you left that screen. Check My tickets in a few minutes.",
    seeTickets: "See my tickets",
    transaction: "Transaction",
    closed: "Entries for this round have closed.",
    notOpenYet: "This round hasn't opened yet.",
    full: "This round is now full.",
    none: "Choose at least one ticket.",
    late: "This round closes within the next few hours. An entry sent now may not arrive in time.",
    gone: "We couldn't find this round any more.",
    unsound: "This round can't take entries.",
    changed: "The total has changed since you confirmed it. Check the new total and try again.",
  }),
  refund: Object.freeze({
    confirm: "Confirm refund",
    cancel: "Cancel",
    fee: "Network fee: under 0.01 CKB, paid from your balance.",
    history: "We couldn't rebuild this round's history. Reload and try again.",
    unavailable: "This entry can't be refunded right now.",
    checking: "Checking the round…",
    approve: "Approve in your wallet…",
    sending: "Sending…",
    waiting: "Sent. Waiting for confirmation…",
    stillWaiting: "This is taking longer than usual. The refund may still go through. Check back in a few minutes.",
    notSent: "The refund was not sent. Your deposit is still safe in the round.",
    rejected: "The network turned this refund down. Your deposit is still safe in the round.",
    pending: "The refund was sent, but we couldn't confirm it yet. Don't send it again. Check back in a few minutes.",
    noWallet: "Your wallet isn't connected any more. Connect it and try again.",
  }),
  draw: Object.freeze({
    title: "The draw",
    notSealed: "The draw hasn't been scheduled yet. This page will show a countdown once it is.",
    working: "Working out the result…",
    noPrizes: "This round didn't get enough tickets, so no prizes were drawn. Deposits are returned.",
    results: "Results",
    skip: "Skip to results",
    replay: "Replay",
    ticket: "Ticket",
    connectHint: "Connect your wallet to see your own tickets marked.",
    stage: "A lottery machine. Numbered balls tumble in a glass drum, and one drops out for each prize.",
  }),
  demo: Object.freeze({
    title: "Demo draw",
    notice: "This is a demonstration. The tickets are made up, and no round or money is involved.",
    real: "A real draw uses this same machine, but only after the network has fixed the result.",
    again: "Draw again",
  }),
  backRounds: "← Rounds",
  backHome: "← Home",
  feeLine: "Network fee: under 0.01 CKB, not returned",
  claimSoon: "Prize claiming opens soon.",
  retireSoon: "Your ticket deposit will be returnable here soon.",
  refundBlocked: "This can't be refunded yet.",
  prizeTable: "What this round pays",
  poolUnknown: "We couldn't read the prize pool just now.",
  noPoolYet: "The prize pool starts growing once the round's tickets are placed in savings.",
  roundEnded: "This round didn't go ahead.",
  youAreHere: "You are here",
  done: "Done",
  ticketPrice: "Ticket price",
  yours: "yours",
});

// Everything this file can say, for the jargon test. A new string that is not
// reachable from here is a string the test cannot see.
function ALL_SAMPLES() {
  const S = roundState().PLAYER_STATE;
  const T = ticketsLib();
  const tip = { height: 1100n, epoch: { number: 1005n, index: 0n, length: 1800n } };
  const config = { entryStart: 1006n, entryEnd: 1010n };
  const out = [];
  for (const state of Object.values(S)) {
    out.push(stateBadge(state, { full: false }), stateBadge(state, { full: true }));
    out.push(milestone({ view: { state }, snapshot: { config, seal: null }, tip }));
    out.push(milestone({ view: { state }, snapshot: { config, seal: { inclusionHeight: 1000n } }, tip }));
  }
  for (const o of Object.values(T.OUTCOME)) out.push(outcomeBadge(o));
  for (const a of Object.values(T.ACTION)) out.push(actionLabel(a));
  out.push(ticketsLine(7n, 10n), ticketsLine(1n, null), estimateLine(4100000000n), estimateLine(1n));
  out.push(costTicket(1n), costDeposit(1n, true), costDeposit(1n, false), costStorage(1n), costExample(1n));
  out.push(placeLine(1, 50n, 1n, true, true), placeLine(2, 30n, 5n, false, true),
    placeLine(3, 20n, 99n, false, false), poolLine(100000000n));
  out.push(enterFor("10,459"), entryConfirmed(1n), entryConfirmed(5n), ticketsLeft(1n), ticketsLeft(3n),
    heldFor("about 30 days"));
  out.push(refundButton(1n), refundReturns(1n), refundDone(1n));
  out.push(resultLine(1, "4", true), resultLine(2, "8", false), drawCountdown(1192n, 1200000n));
  out.push(honestyLine(1192n), winLine(1, 50n, 100n), heldLine(1), heldLine(5), ckb(1n), ordinal(2));
  for (const v of Object.values(errors)) out.push(typeof v === "function" ? v("popup closed") : v);
  const walk = (v) => {
    if (typeof v === "string") out.push(v); else for (const x of Object.values(v)) walk(x);
  };
  walk(text);
  return out.filter((s) => s !== "");
}

const api = {
  ckb, ordinal, plural, shortAddress, stateBadge, ticketsLine, milestone, outcomeBadge, actionLabel,
  estimateLine, honestyLine, winLine, heldLine, costTicket, costDeposit, costStorage, costExample,
  placeLine, poolLine, resultLine, drawCountdown, refundButton, refundReturns, refundDone, enterFor, entryConfirmed, ticketsLeft, heldFor, errors, text, ALL_SAMPLES,
};
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowCopy = api;
})();
