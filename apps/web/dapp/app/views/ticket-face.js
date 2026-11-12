import { h } from "../dom.js";

const copy = () => window.DaowowCopy;

// One ticket, as the parchment artwork with its details printed on it. The
// words are real text laid over the picture, so they stay sharp at any size
// and a screen reader reads them.
export function ticketFace(face) {
  const words = copy().text.face;
  const when = (moment) => copy().momentLine(window.DaowowTime.formatMoment(moment.ms), moment.exact);
  const fact = (label, value, extra = {}) =>
    h("div", {}, h("dt", {}, label), h("dd", extra, value));
  const facts = [fact(words.hash, h("code", {}, copy().shortHash(face.ticketId)), { title: face.ticketId })];
  // A date that could not be read is left off the ticket, not guessed.
  if (face.opens) facts.push(fact(words.opens, when(face.opens)));
  if (face.closes) facts.push(fact(words.closes, when(face.closes)));
  if (face.draw) facts.push(fact(words.draw, when(face.draw)));
  else if (face.drawPending) facts.push(fact(words.draw, words.drawSoon));

  // Each button names its own ticket, and what happened is announced beside
  // it, so the button goes on saying what it does.
  const said = h("span", { class: "ticket-copied", role: "status" });
  let clearing = null;
  const copyButton = h("button", {
    class: "link-button ticket-copy", type: "button", "aria-label": copy().copyHashOf(face.number),
  }, `${words.copyHash} ${words.hash.toLowerCase()}`);
  copyButton.addEventListener("click", () => {
    const say = (text) => {
      said.textContent = text;
      clearTimeout(clearing);
      clearing = setTimeout(() => { said.textContent = ""; }, 4000);
    };
    navigator.clipboard.writeText(face.ticketId).then(() => say(words.copied), () => say(words.copyFailed));
  });

  return h("li", { class: "ticket-slot" },
    h("div", { class: `ticket ticket-${face.art}` },
      h("div", { class: "ticket-face" },
        h("div", { class: "ticket-top" },
          h("p", { class: "ticket-round" }, face.roundLabel),
          h("p", { class: face.longNumber ? "ticket-number ticket-number-long" : "ticket-number" },
            copy().ticketNo(face.number))),
        h("div", { class: "ticket-bottom" },
          face.result ? h("p", { class: "ticket-result" }, copy().faceResult(face.result)) : null,
          h("dl", { class: "ticket-facts" }, facts)))),
    h("div", { class: "ticket-tools" }, copyButton, said));
}
