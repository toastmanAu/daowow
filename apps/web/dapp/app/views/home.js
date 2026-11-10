// Filled in by a later task; for now the tab shows that it is alive.
import { h, clear } from "../dom.js";

export function render(node, ctx) {
  clear(node).append(h("div", { class: "card" },
    h("p", { class: "empty" }, `${ctx.store.state.rows.length} rounds found.`)));
}
