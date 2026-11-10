"use strict";
// Wrapped in an IIFE: loaded as a classic script these files share one
// global scope, so top-level declarations would collide between modules.
(function () {
// Hash routes, so a shared link to a tab or a round still works and switching
// tabs never reloads the page.
//
//   #/home  #/rounds  #/tickets  #/how
//   #/round/<id prefix>/enter    #/round/<id prefix>/draw
//
// The hash is attacker-reachable, so it is matched against this closed set
// and nothing from it is ever echoed back to the page.

const TABS = Object.freeze(["home", "rounds", "tickets", "how"]);
const PANELS = Object.freeze(["enter", "draw"]);
// At least 8 characters: ids can be ground to collide on a short prefix, and
// a link that could mean two rounds must mean neither.
const ROUND_TOKEN = /^[0-9a-f]{8,64}$/i;

const UNKNOWN = Object.freeze({ tab: "home", round: null, panel: null, unknown: true });

function parseRoute(hash) {
  const path = String(hash ?? "").replace(/^#/, "").replace(/^\//, "");
  if (path === "") return { tab: "home", round: null, panel: null, unknown: false };
  const parts = path.split("/");
  if (parts.length === 1 && TABS.includes(parts[0])) {
    return { tab: parts[0], round: null, panel: null, unknown: false };
  }
  if (parts.length === 3 && parts[0] === "round"
      && ROUND_TOKEN.test(parts[1]) && PANELS.includes(parts[2])) {
    return { tab: "rounds", round: parts[1].toLowerCase(), panel: parts[2], unknown: false };
  }
  return { ...UNKNOWN };
}

function formatRoute({ tab, round, panel }) {
  if (round && panel) {
    return `#/round/${String(round).replace(/^0x/, "").toLowerCase().slice(0, 8)}/${panel}`;
  }
  return `#/${tab}`;
}

const api = { parseRoute, formatRoute, TABS };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowRoute = api;
})();
