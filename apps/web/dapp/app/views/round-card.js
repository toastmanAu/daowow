// One round, as a card: its name, its state, how full it is, what happens
// next, and the one thing a player can do about it.
import { h, badge } from "../dom.js";

const copy = () => window.DaowowCopy;
const S = () => window.DaowowRoundState.PLAYER_STATE;

export function stateTone(view) {
  const s = S();
  if (view.state === s.OPEN) return view.full ? "warm" : "good";
  if (view.state === s.DRAWN || view.state === s.REFUNDS) return "warm";
  if (view.state === s.FINISHED) return "quiet";
  return "neutral";
}

export function progressBar(view) {
  if (view.cap === null) return null;
  return h("progress", {
    class: "fill", max: String(view.cap), value: String(view.ticketsSold),
    "aria-label": copy().ticketsLine(view.ticketsSold, view.cap),
  });
}

/** The hex id, for anyone who wants it. Never in the card's face. */
export function roundDetails(row) {
  return h("details", {},
    h("summary", {}, copy().text.details),
    h("p", { class: "muted" }, `${copy().text.roundId}: `,
      h("span", { class: "mono" }, row.snapshot.config.roundId)));
}

export function roundAction(row) {
  const s = S();
  const route = window.DaowowRoute.formatRoute;
  const round = row.snapshot.config.roundId;
  if (row.view.state === s.OPEN && !row.view.full && row.schedule && row.sound) {
    return h("a", { class: "primary-button", href: route({ round, panel: "enter" }) },
      copy().text.enter);
  }
  if (row.view.state === s.DRAWN) {
    return h("a", { class: "secondary-button", href: route({ round, panel: "draw" }) },
      copy().actionLabel(window.DaowowTickets.ACTION.WATCH_DRAW));
  }
  return null;
}

export function roundCard(row, ctx, { action = true } = {}) {
  const { view, snapshot } = row;
  const act = action ? roundAction(row) : null;
  return h("article", { class: "card" },
    h("div", { class: "card-head" },
      h("h2", {}, row.label),
      badge(copy().stateBadge(view.state, view), stateTone(view))),
    h("div", { class: "stack-tight" },
      progressBar(view),
      h("p", { class: "muted" }, copy().ticketsLine(view.ticketsSold, view.cap))),
    h("p", {}, copy().milestone({ view, snapshot, tip: ctx.store.state.tip })),
    act ? h("div", { class: "actions" }, act) : null,
    roundDetails(row));
}
