// Building the page without ever parsing a string as HTML.
//
// Round data, wallet data and error messages all reach the page through here,
// as text nodes. A node's error body or a link someone shared can carry
// markup; on a page trusted with a wallet that must stay text.

const copy = () => window.DaowowCopy;

/**
 * h("p", { class: "sub" }, "text", child). String children become TEXT.
 * Props: class, id, hidden, disabled, href, type, value, for, role, and any
 * aria-*, data-* or on<event>.
 */
export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "class") {
      node.className = value;
    } else if (key === "hidden" || key === "disabled" || key === "open" || key === "checked") {
      node[key] = Boolean(value);
    } else {
      node.setAttribute(key === "htmlFor" ? "for" : key, String(value));
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

export function clear(node) {
  node.textContent = "";
  return node;
}

/** A plain-words headline; the system's own words stay behind a disclosure. */
export function errorBox(headline, detail) {
  return h("div", { class: "error", role: "alert" },
    h("p", {}, headline),
    detail
      ? h("details", {}, h("summary", {}, copy().text.technical), h("code", {}, String(detail)))
      : null);
}

export function showError(node, headline, detail) {
  clear(node).append(errorBox(headline, detail));
}

/** An error the player can act on: what happened, and a button to try again. */
export function showRetry(node, headline, onRetry, detail) {
  clear(node).append(h("div", { class: "card" },
    errorBox(headline, detail),
    h("button", { class: "secondary-button", type: "button", onclick: onRetry }, copy().text.retry)));
}

export function loadingCard() {
  return h("div", { class: "card" }, h("p", { class: "empty" }, copy().text.loading));
}

export function badge(text, tone = "neutral") {
  return h("span", { class: `badge badge-${tone}` }, text);
}
