// Rounds: every round under this deployment, grouped by what a player can do.
import { h, clear } from "../dom.js";
import { roundCard } from "./round-card.js";

const copy = () => window.DaowowCopy;
const ORDER = ["open", "upcoming", "waiting", "finished"];

export function render(node, ctx) {
  clear(node);
  const groups = window.DaowowRoundState.groupRounds(ctx.store.state.rows);
  const shown = ORDER.filter((key) => groups[key].length > 0);
  if (shown.length === 0) {
    node.append(h("div", { class: "card" }, h("p", { class: "empty" }, copy().text.noRounds)));
    return;
  }
  for (const key of shown) {
    node.append(
      h("h2", { class: "group-heading" }, copy().text.groups[key]),
      ...groups[key].map((row) => roundCard(row, ctx)));
  }
}
