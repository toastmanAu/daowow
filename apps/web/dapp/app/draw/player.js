// Showing one draw result: the ball machine where it can run, the plain list
// where it cannot. The round's draw screen and the demo both use this, so
// there is one fallback path and one place the 3D library is loaded.
//
// It is given a finished draw script. It never chooses or reorders a winner.
import { h, clear } from "../dom.js";
import { renderResultList, resultItem } from "./fallback.js";

const copy = () => window.DaowowCopy;

const reducedMotion = () =>
  window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * @param {object} script from DaowowDrawScript.buildDrawScript; must be viable
 * @returns {{nodes: Node[], start: () => Promise<void>, dispose: () => void}}
 *   `nodes` go into the caller's card, in order. `start` begins the showing.
 */
export function createPlayer(script) {
  const words = copy().text.draw;
  let stage = null;
  let disposed = false;

  const rail = h("ol", { class: "rail", "aria-live": "polite" });
  const host = h("div", { class: "draw-stage", hidden: true });
  const note = h("p", { class: "muted", hidden: true });
  const skip = h("button", { class: "secondary-button", type: "button",
    onclick: () => stage && stage.skip() }, words.skip);
  const replay = h("button", { class: "secondary-button", type: "button",
    onclick: () => { if (stage) { clear(rail); stage.replay(); } } }, words.replay);
  const controls = h("div", { class: "actions", hidden: true }, skip, replay);

  const stopStage = () => {
    if (stage) { try { stage.dispose(); } catch { /* already freed */ } }
    stage = null;
  };

  const asList = (why) => {
    host.hidden = true;
    controls.hidden = true;
    if (why) { note.textContent = why; note.hidden = false; }
    renderResultList(rail, script);
  };

  async function start() {
    if (reducedMotion()) { asList(null); return; }
    try {
      // Loaded only when a draw is actually watched: the 3D library is the
      // largest file on the site and most visits never need it.
      const { createStage } = await import("./stage.js");
      if (disposed) return;
      const canvas = h("canvas", { role: "img", "aria-label": words.stage });
      host.append(canvas);
      host.hidden = false;
      stage = createStage(canvas, script, {
        onReveal: (reveal) => rail.append(resultItem(reveal)),
        onDone: () => {},
      });
      controls.hidden = false;
      stage.play();
    } catch {
      // No WebGL, or the scene failed. The result is the same list either way.
      stopStage();
      clear(host);
      if (!disposed) asList(copy().errors.noWebgl);
    }
  }

  return {
    nodes: [host, controls, h("h3", {}, words.results), rail, note],
    start,
    dispose() { disposed = true; stopStage(); },
  };
}
