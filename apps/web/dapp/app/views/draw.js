// Watching a draw: a live countdown before the result exists, then the
// reveal, and a replay any time after.
//
// The result is never made here. The store worked it out from four block
// hashes and checked it against the operator's record; this screen shows that
// result or shows nothing. If the check failed there are no winners on
// screen, only the error.
import { h, clear } from "../dom.js";
import { renderResultList, resultItem } from "../draw/fallback.js";

const copy = () => window.DaowowCopy;
const COUNTDOWN_REFRESH_MS = 15000;

const reducedMotion = () =>
  window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function mount(node, ctx, firstRow) {
  const words = copy().text.draw;
  let row = firstRow;
  let stage = null;
  let shownKey = null;
  let firstSeed = null; // the first result this screen showed
  let disposed = false;
  const body = h("div", {});
  clear(node).append(body);

  const stopStage = () => {
    if (stage) { try { stage.dispose(); } catch { /* already freed */ } }
    stage = null;
  };

  function myPositions() {
    const card = (ctx.store.state.mine ?? [])
      .find((c) => c.roundId === row.snapshot.config.roundId);
    return card ? card.positions : [];
  }

  function message(text, extra) {
    stopStage();
    shownKey = null;
    clear(body).append(h("div", { class: "card" },
      h("h2", {}, `${row.label} · ${words.title}`), h("p", {}, text), extra ?? null));
  }

  async function showResult(phase) {
    const mine = myPositions();
    // Painted once per result. The store re-reads the chain every minute and
    // that must not restart an animation someone is watching.
    const key = `${row.draw.seed}/${mine.join(",")}`;
    if (key === shownKey) return;
    stopStage();
    shownKey = key;
    firstSeed = row.draw.seed;

    const script = window.DaowowDrawScript.buildDrawScript({ draw: row.draw, myPositions: mine });
    const honesty = h("p", { class: "honesty" }, copy().honestyLine(phase.lastHeight));
    if (!script.viable) {
      clear(body).append(h("div", { class: "card" },
        h("h2", {}, `${row.label} · ${words.title}`), h("p", {}, words.noPrizes), honesty));
      return;
    }

    const rail = h("ol", { class: "rail", "aria-live": "polite" });
    const host = h("div", { class: "draw-stage", hidden: true });
    const note = h("p", { class: "muted", hidden: true });
    const skip = h("button", { class: "secondary-button", type: "button" }, words.skip);
    const replay = h("button", { class: "secondary-button", type: "button" }, words.replay);
    const controls = h("div", { class: "actions", hidden: true }, skip, replay);
    clear(body).append(h("div", { class: "card" },
      h("h2", {}, `${row.label} · ${words.title}`),
      honesty,
      host,
      controls,
      h("h3", {}, words.results),
      rail,
      note,
      ctx.store.state.session ? null : h("p", { class: "muted" }, words.connectHint)));

    const asList = (why) => {
      host.hidden = true;
      controls.hidden = true;
      if (why) { note.textContent = why; note.hidden = false; }
      renderResultList(rail, script);
    };
    if (reducedMotion()) { asList(null); return; }

    try {
      // Loaded only when a draw is actually watched: the 3D library is the
      // largest file on the site and most visits never need it.
      const { createStage } = await import("../draw/stage.js");
      if (disposed || shownKey !== key) return;
      const canvas = h("canvas", { role: "img", "aria-label": words.stage });
      host.append(canvas);
      host.hidden = false;
      stage = createStage(canvas, script, {
        onReveal: (reveal) => rail.append(resultItem(reveal)),
        onDone: () => {},
      });
      controls.hidden = false;
      skip.addEventListener("click", () => stage && stage.skip());
      replay.addEventListener("click", () => { clear(rail); if (stage) stage.replay(); });
      stage.play();
    } catch {
      // No WebGL, or the scene failed. The result is the same list either way.
      stopStage();
      clear(host);
      asList(copy().errors.noWebgl);
    }
  }

  function paint() {
    if (disposed) return;
    const tip = ctx.store.state.tip;
    const phase = window.DaowowDrawScript.drawPhase({
      snapshot: row.snapshot, tipHeight: tip.height, hasDraw: Boolean(row.draw),
    });
    // A block the result depended on was replaced after winners were shown.
    // Different winners must not simply appear in their place.
    if (row.draw && window.DaowowDrawScript.resultChanged(firstSeed, row.draw)) {
      message(copy().errors.drawChanged);
      return;
    }
    if (phase.phase === "not-sealed") { message(words.notSealed); return; }
    if (phase.blocksLeft === 0n && row.drawError) {
      // Unconfirmed means unshown. No winners appear beside this error.
      message(copy().errors.draw, h("details", {},
        h("summary", {}, copy().text.technical), h("p", { class: "muted" }, row.drawError)));
      return;
    }
    if (phase.phase === "countdown") {
      const ms = window.DaowowTime.msUntilBlock(phase.lastHeight, tip.height);
      message(phase.blocksLeft > 0n ? copy().drawCountdown(phase.lastHeight, ms) : words.working);
      return;
    }
    showResult(phase);
  }

  paint();
  // While a sealed round counts down to its result, look again every few
  // seconds so the countdown is live and the reveal starts without a reload.
  // Started after the first paint, so a screen that failed to draw leaves no
  // timer behind.
  const timer = window.setInterval(() => {
    if (disposed || document.hidden) return;
    if (window.DaowowDrawScript.needsPolling({
      snapshot: row.snapshot, draw: row.draw, drawError: row.drawError,
    })) ctx.store.refresh();
  }, COUNTDOWN_REFRESH_MS);

  return {
    update(next) { row = next; paint(); },
    dispose() { disposed = true; window.clearInterval(timer); stopStage(); },
  };
}
