// The draw's result as a plain list. This is what a screen reader hears, what
// "reduce motion" shows, and what a device without WebGL gets. The animation
// is a nicer way to arrive at exactly this list.
import { h, clear } from "../dom.js";

const copy = () => window.DaowowCopy;

export function resultItem(reveal) {
  return h("li", { class: reveal.mine ? "mine" : "" },
    copy().resultLine(reveal.place, reveal.label, reveal.mine));
}

export function renderResultList(list, script) {
  clear(list);
  for (const reveal of script.reveals) list.append(resultItem(reveal));
}
