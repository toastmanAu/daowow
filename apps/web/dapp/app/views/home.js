// Home: what DAOWOW is, with the current round's real figures in it.
//
// The fixed explanation lives in index.html. This fills in the parts that
// come from the chain: the current round, where it is on its timeline, what
// a ticket costs right now, and what the round pays.
import { h, clear } from "../dom.js";
import { roundCard } from "./round-card.js";

const el = (id) => document.getElementById(id);
const copy = () => window.DaowowCopy;

// The shape of a JoyID lock, for quoting the ticket deposit before anyone has
// connected. The figure is still computed by quote.js, never typed in.
const JOYID_SHAPED = { args: "0x" + "00".repeat(22) };

function timeline(row, tip) {
  const { steps, ended } = window.DaowowTimeline.buildTimeline({
    snapshot: row.snapshot, view: row.view, tip,
  });
  if (ended) return h("p", { class: "muted" }, copy().text.roundEnded);
  return h("ol", { class: "timeline" }, steps.map((step) =>
    h("li", { class: step.here ? "here" : step.done ? "done" : "", "aria-current": step.here ? "step" : null },
      h("span", { class: "timeline-label" }, step.label),
      h("span", { class: "muted" },
        step.here ? `${copy().text.youAreHere}${step.when ? ` · ${step.when}` : ""}`
          : step.done ? copy().text.done : step.when))));
}

function cost(row, session) {
  const quote = window.DaowowQuote;
  const lock = session ? session.lockScript : JOYID_SHAPED;
  const price = row.snapshot.config.ticketPrice;
  const deposit = quote.claimCellCapacity(lock);
  const storage = quote.entryCellCapacity(0n);
  return h("div", { class: "stack-tight" },
    h("ul", { class: "plain-list" },
      h("li", {}, copy().costTicket(price)),
      h("li", {}, copy().costDeposit(deposit, Boolean(session))),
      h("li", {}, copy().costStorage(storage)),
      h("li", {}, copy().text.feeLine)),
    h("p", { class: "muted" }, copy().costExample(price + deposit + storage)));
}

function prizes(row) {
  if (!row.schedule) return h("p", { class: "muted" }, copy().errors.schedule);
  const payout = window.DaowowEntryView.describePayout(
    row.schedule, row.view.ticketsSold, row.snapshot.config.maximumTickets);
  return h("div", { class: "stack-tight" },
    h("p", {}, payout.summary),
    h("ol", { class: "plain-list" }, payout.rows.map((r) =>
      h("li", { class: r.open ? "" : "muted" },
        copy().placeLine(r.place, r.share, r.opensAt, r.open, r.reachable)))),
    h("p", { class: row.pool === null ? "muted" : "figure" },
      row.pool === null ? copy().text.noPoolYet : copy().poolLine(row.pool)));
}

function enterButton(row) {
  const S = window.DaowowRoundState.PLAYER_STATE;
  const open = row && row.view.state === S.OPEN && !row.view.full && row.schedule && row.sound;
  if (open) {
    return [h("a", {
      class: "primary-button",
      href: window.DaowowRoute.formatRoute({ round: row.snapshot.config.roundId, panel: "enter" }),
    }, copy().text.enterCurrent)];
  }
  return [
    h("button", { class: "primary-button", type: "button", disabled: true }, copy().text.enterCurrent),
    h("p", { class: "muted" }, copy().text.notOpen),
  ];
}

export function render(node, ctx) {
  const { state } = ctx.store;
  const row = ctx.store.currentRound();
  clear(node);
  const parts = { round: el("home-round"), timeline: el("home-timeline"), cost: el("home-cost"),
    prizes: el("home-prizes"), enter: el("home-enter") };
  for (const part of Object.values(parts)) clear(part);
  if (!row) {
    parts.round.append(h("div", { class: "card" }, h("p", { class: "empty" }, copy().text.noRounds)));
    parts.enter.append(...enterButton(null));
    return;
  }
  parts.round.append(roundCard(row, ctx, { action: false }));
  parts.timeline.append(timeline(row, state.tip));
  parts.cost.append(cost(row, state.session));
  parts.prizes.append(prizes(row));
  parts.enter.append(...enterButton(row));
}
