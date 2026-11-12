// My tickets: one card per round this wallet holds something in, with the
// one action that applies sitting on the card.
import { h, clear, errorBox, showRetry, badge } from "../dom.js";
import { roundDetails } from "./round-card.js";
import { ticketFace } from "./ticket-face.js";

const copy = () => window.DaowowCopy;
const T = () => window.DaowowTickets;

// A refund in progress, kept outside render() because the store re-renders
// this tab whenever the chain is re-read, and that must not wipe the status
// of a transaction that is out for signature.
const flow = { key: null, stage: "idle", text: "", error: null };
const keyOf = (entry) => `${entry.outPoint.txHash}:${entry.outPoint.index}`;
const resetFlow = () => Object.assign(flow, { key: null, stage: "idle", text: "", error: null, owner: null });

function tone(outcome) {
  const O = T().OUTCOME;
  if (outcome === O.WON || outcome === O.REFUNDABLE) return "warm";
  if (outcome === O.IN_ROUND) return "good";
  if (outcome === O.DID_NOT_RUN || outcome === O.NOT_THIS_TIME) return "quiet";
  return "neutral";
}

function winLines(card, row) {
  // The cards and the rounds are read moments apart; a card can briefly say
  // "won" for a round whose result is not in hand.
  if (!row.draw || !row.schedule) return [];
  const est = window.DaowowPrizeEstimate;
  const tickets = row.draw.tickets;
  const estimate = est.estimatePrizes({ schedule: row.schedule, tickets, poolSoFar: row.pool });
  return card.wins.map((win) => {
    const share = est.shareOf(row.schedule, tickets, win.place);
    return h("div", { class: "stack-tight" },
      h("p", { class: "figure" },
        share ? copy().winLine(win.place, share.weight, share.total) : copy().ordinal(win.place)),
      // Before the round's deposit exists there is no figure to show, only
      // the place and the share.
      estimate ? h("p", {}, copy().estimateLine(estimate.prizes[win.place - 1])) : null);
  });
}

async function runRefund(ctx, card, entry) {
  const words = copy().text.refund;
  const lines = { checking: words.checking, approve: words.approve, sending: words.sending, waiting: words.waiting };
  flow.stage = "busy";
  flow.error = null;
  flow.owner = ctx.store.state.session ? ctx.store.state.session.address : null;
  // The sequence lives in model/send-flow.js, where it is tested: read the
  // round again, build from the replayed history, and never say "not sent"
  // about a refund that was broadcast.
  const guard = window.DaowowRefundGuard;
  const outcome = await window.DaowowSendFlow.runRefund({
    check: () => guard.checkBeforeRefund({
      store: ctx.store, roundId: card.roundId, outPoint: entry.outPoint,
    }),
    prepare: (checked, session) => guard.prepareRefund({
      rpc: ctx.rpc, manifest: ctx.manifest, row: checked.row, entry: checked.entry, session,
      nowEpoch: checked.nowEpoch,
    }),
    signer: () => ctx.signing(),
    isLive: () => true,
    watch: (txHash) => window.DaowowSendFlow.watchTransaction({ rpc: ctx.rpc, txHash }),
    say: (stage) => { flow.text = lines[stage] ?? ""; ctx.rerender(); },
  });

  const fail = (headline, detail) => {
    flow.stage = "error";
    flow.text = "";
    flow.error = { headline, detail: detail ?? null };
  };
  if (outcome.stage === "confirmed") {
    flow.stage = "done";
    flow.text = copy().refundDone(entry.capacity);
    await ctx.store.refresh();
  } else if (outcome.stage === "pending") {
    // Sent, not yet confirmed. Shown as done-for-now so the button is gone.
    flow.stage = "done";
    flow.text = words.pending;
  } else if (outcome.stage === "refused") {
    fail(outcome.message, outcome.detail);
  } else if (outcome.stage === "no-wallet") {
    fail(words.noWallet);
  } else if (outcome.stage === "rejected") {
    fail(words.rejected, outcome.detail);
  } else {
    fail(words.notSent, outcome.detail);
  }
  ctx.rerender();
}

function refundBlock(ctx, card, entry) {
  const words = copy().text.refund;
  const mine = flow.key === keyOf(entry);
  const busyElsewhere = flow.stage === "busy" && !mine;
  if (!mine || flow.stage === "idle") {
    return h("div", { class: "actions" },
      h("button", {
        class: "primary-button", type: "button", disabled: busyElsewhere,
        onclick: () => { Object.assign(flow, { key: keyOf(entry), stage: "confirm", text: "", error: null }); ctx.rerender(); },
      }, copy().refundButton(entry.capacity)));
  }
  if (flow.stage === "confirm") {
    // What moves, said before the wallet is asked for anything.
    return h("div", { class: "confirm-box" },
      h("p", { class: "figure" }, copy().refundReturns(entry.capacity)),
      h("p", { class: "muted" }, words.fee),
      h("div", { class: "actions" },
        h("button", { class: "primary-button", type: "button", onclick: () => runRefund(ctx, card, entry) },
          words.confirm),
        h("button", { class: "secondary-button", type: "button", onclick: () => { resetFlow(); ctx.rerender(); } },
          words.cancel)));
  }
  if (flow.stage === "error") {
    return h("div", { class: "stack-tight" },
      errorBox(flow.error.headline, flow.error.detail),
      h("button", { class: "secondary-button", type: "button", onclick: () => { resetFlow(); ctx.rerender(); } },
        copy().text.retry));
  }
  return h("p", { class: "status", role: "status" }, flow.text);
}

function ticketCard(ctx, card, row) {
  const { OUTCOME: O, ACTION: A } = T();
  const route = window.DaowowRoute.formatRoute;
  const parts = [
    h("div", { class: "card-head" },
      h("h2", {}, row.label),
      badge(copy().outcomeBadge(card.outcome), tone(card.outcome))),
  ];
  if (card.ticketsHeld > 0) parts.push(h("p", {}, copy().heldLine(card.ticketsHeld)));
  const faces = window.DaowowTicketFace.buildTicketFaces({ card, label: row.label });
  if (faces.length > 0) {
    parts.push(h("ul", { class: "ticket-row", "aria-label": copy().text.face.listLabel },
      faces.map(ticketFace)));
  }
  if (card.multiShard) parts.push(h("p", { class: "muted" }, copy().errors.multiShard));
  if (row.drawError && row.view.state === window.DaowowRoundState.PLAYER_STATE.DRAWN) {
    parts.push(errorBox(copy().errors.draw, row.drawError));
  }
  if (card.outcome === O.WON) parts.push(...winLines(card, row));

  for (const entry of card.refundable) parts.push(refundBlock(ctx, card, entry));
  if (card.outcome === O.REFUND_LATER || card.outcome === O.REFUNDABLE) {
    for (const blocked of card.blocked) {
      parts.push(h("div", { class: "stack-tight" },
        h("p", { class: "muted" }, copy().text.refundBlocked),
        h("details", {}, h("summary", {}, copy().text.technical),
          h("p", { class: "muted" }, blocked.reason))));
    }
  }

  const links = [];
  if (card.actions.includes(A.ENTER_MORE)) {
    links.push(h("a", { class: "primary-button", href: route({ round: card.roundId, panel: "enter" }) },
      copy().actionLabel(A.ENTER_MORE)));
  }
  if (card.actions.includes(A.WATCH_DRAW)) {
    links.push(h("a", { class: "secondary-button", href: route({ round: card.roundId, panel: "draw" }) },
      copy().actionLabel(A.WATCH_DRAW)));
  }
  if (links.length > 0) parts.push(h("div", { class: "actions" }, links));
  // Coming-soon actions are sentences, never buttons: a button that does
  // nothing is a dead end.
  if (card.actions.includes(A.CLAIM_SOON)) parts.push(h("p", { class: "muted" }, copy().text.claimSoon));
  if (card.actions.includes(A.RETIRE_SOON)) parts.push(h("p", { class: "muted" }, copy().text.retireSoon));
  parts.push(roundDetails(row));
  return h("article", { class: "card" }, parts);
}

export function render(node, ctx) {
  const { state } = ctx.store;
  const view = { ...ctx, rerender: () => render(node, ctx) };
  clear(node);
  if (!state.session) {
    resetFlow();
    node.append(h("div", { class: "card" },
      h("p", { class: "empty" }, copy().text.connectPrompt),
      h("button", { class: "primary-button", type: "button", onclick: () => ctx.connect() },
        copy().text.connect)));
    return;
  }
  // A refund's status belongs to the wallet that made it.
  if (flow.owner && flow.owner !== state.session.address && flow.stage !== "busy") resetFlow();
  if (state.mineError) {
    showRetry(node, copy().errors.mine, () => ctx.store.refresh(), state.mineError);
    return;
  }
  if (state.mine === null) {
    node.append(h("div", { class: "card" }, h("p", { class: "empty" }, copy().text.loading)));
    return;
  }
  // A finished refund removes its entry from the wallet, so its confirmation
  // is shown above the cards rather than on a card that may be gone.
  if (flow.stage === "done") {
    node.append(h("div", { class: "notice-good", role: "status" },
      h("span", {}, flow.text),
      h("button", { class: "link-button", type: "button", onclick: () => { resetFlow(); view.rerender(); } },
        copy().text.dismiss)));
  }
  if (state.mine.length === 0) {
    node.append(h("div", { class: "card" },
      h("p", { class: "empty" }, copy().text.noTickets),
      h("a", { class: "secondary-button", href: "#/rounds" }, copy().text.seeRounds)));
    return;
  }
  for (const card of state.mine) {
    const row = state.rows.find((r) => r.snapshot.config.roundId === card.roundId);
    if (row) node.append(ticketCard(view, card, row));
  }
}
