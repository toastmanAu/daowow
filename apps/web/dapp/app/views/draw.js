// Watching a draw: a live countdown before the result exists, then the
// reveal, and a replay any time after.
//
// The result is never made here. The store worked it out from four block
// hashes and checked it against the operator's record; this screen shows that
// result or shows nothing. If the check failed there are no winners on
// screen, only the error.
import { h, clear } from "../dom.js";
import { createPlayer } from "../draw/player.js";

const copy = () => window.DaowowCopy;
const COUNTDOWN_REFRESH_MS = 15000;

export function mount(node, ctx, firstRow) {
  const words = copy().text.draw;
  let row = firstRow;
  let player = null; // the machine or list showing the current result
  let shownKey = null;
  let firstSeed = null; // the first result this screen showed
  let disposed = false;
  const body = h("div", {});
  clear(node).append(body);

  const stopStage = () => {
    if (player) player.dispose();
    player = null;
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

  function showResult(phase) {
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

    player = createPlayer(script);
    clear(body).append(h("div", { class: "card" },
      h("h2", {}, `${row.label} · ${words.title}`),
      honesty,
      ...player.nodes,
      ctx.store.state.session ? null : h("p", { class: "muted" }, words.connectHint)));
    player.start();
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
