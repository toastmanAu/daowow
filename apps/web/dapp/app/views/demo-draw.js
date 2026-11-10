// The demo draw: the ball machine run on a pretend round, opened from Home.
//
// It reads nothing from the network and nothing from a wallet, so it works
// before either has answered. Its winners come from DaowowDemoDraw, which
// uses the real selection function under a seed no real round can have. The
// screen says it is a demonstration before it shows anything else.
import { h, clear } from "../dom.js";
import { createPlayer } from "../draw/player.js";

const copy = () => window.DaowowCopy;

export function mount(node) {
  const words = copy().text.demo;
  const demo = window.DaowowDemoDraw;
  let run = 1;
  let player = null;
  let disposed = false;

  const stop = () => {
    if (player) player.dispose();
    player = null;
  };

  function show() {
    stop();
    if (disposed) return;
    const script = window.DaowowDrawScript.buildDrawScript({
      draw: demo.buildDemoDraw(run), myPositions: [],
    });
    player = createPlayer(script);
    const again = h("button", { class: "secondary-button", type: "button",
      onclick: () => { run = demo.nextRun(run); show(); } }, words.again);
    clear(node).append(h("div", { class: "card" },
      h("h2", {}, words.title),
      h("p", { class: "honesty" }, words.notice),
      ...player.nodes,
      h("p", { class: "muted" }, words.real),
      h("div", { class: "actions" },
        again,
        h("a", { class: "secondary-button", href: "#/rounds" }, copy().text.seeRounds))));
    player.start();
  }

  show();
  return {
    update() { /* nothing on this screen comes from the chain */ },
    dispose() { disposed = true; stop(); },
  };
}
