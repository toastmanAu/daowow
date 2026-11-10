// Filled in by a later task.
import { h, clear } from "../dom.js";

export function mount(node, ctx, row) {
  clear(node).append(h("div", { class: "card" }, h("h2", {}, row.label)));
  return { update() {}, dispose() {} };
}
