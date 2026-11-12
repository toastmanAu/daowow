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

  const copyButton = h("button", { class: "link-button ticket-copy", type: "button" },
    `${words.copyHash} ${words.hash.toLowerCase()}`);
  copyButton.addEventListener("click", async () => {
    let said = words.copied;
    try { await navigator.clipboard.writeText(face.ticketId); } catch { said = words.copyFailed; }
    copyButton.textContent = said;
  });

  return h("li", { class: "ticket-slot" },
    h("div", { class: `ticket ticket-${face.art}` },
      h("div", { class: "ticket-face" },
        h("div", { class: "ticket-top" },
          h("p", { class: "ticket-round" }, face.roundLabel),
          h("p", { class: "ticket-number" }, copy().ticketNo(face.number))),
        h("div", { class: "ticket-bottom" },
          face.result ? h("p", { class: "ticket-result" }, copy().faceResult(face.result)) : null,
          h("dl", { class: "ticket-facts" }, facts)))),
    copyButton);
}
