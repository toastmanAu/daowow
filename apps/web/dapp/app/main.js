// The one app. Connect once, then move between tabs without a reload.
//
// This file only wires things together: it loads the deployment, builds the
// shared store, owns the wallet session, and shows the section the address
// bar names. Every decision it displays is made in ../model/, where it is
// tested.

import { createWallet } from "../../chain/wallet.js";
import { h, clear, showError, showRetry, loadingCard } from "./dom.js";
import { fetchSchedule } from "./chain-read.js";
import * as home from "./views/home.js";
import * as rounds from "./views/rounds.js";
import * as tickets from "./views/tickets.js";
import * as enter from "./views/enter.js";
import * as draw from "./views/draw.js";

const el = (id) => document.getElementById(id);
const copy = () => window.DaowowCopy;
const REFRESH_MS = 60000;

const TAB_VIEWS = { home, rounds, tickets };
const PANEL_VIEWS = { enter, draw };

function readers() {
  const cells = window.DaowowRoundCells;
  return {
    readTip: (rpc) => rpc.call("get_tip_header", []),
    readDeployment: cells.readDeployment,
    countEntries: cells.countEntries,
    readSchedule: fetchSchedule,
    readEntropyHeaders: window.DaowowEntropyDerive.readEntropyHeaders,
    readPoolSoFar: window.DaowowDaoYield.readPoolSoFar,
    findClaims: cells.findClaims,
    findMyEntries: cells.findMyEntries,
    scriptHash: window.DaowowRefundTx.scriptHash,
  };
}

async function loadManifest() {
  const res = await fetch("./manifest.json", { cache: "no-cache" });
  if (!res.ok) throw new Error(`${res.status} loading the site settings`);
  return window.DaowowManifest.loadManifest(await res.json());
}

function showNotice(text) {
  const node = el("notice");
  clear(node);
  node.hidden = !text;
  if (!text) return;
  node.append(
    h("span", {}, text),
    h("button", { class: "link-button", type: "button", onclick: () => showNotice("") }, "Dismiss"));
}

// The wallet pill. The session lives in the store, inside this module's
// closure; nothing is hung on `window`, so no other script can reach the
// signing operations by reading a global.
function createWalletControl({ manifest, store }) {
  const button = el("wallet");
  const menu = el("wallet-menu");
  let wallet = null;
  let busy = false;
  const ensure = () => (wallet ??= createWallet({ rpcUrl: manifest.rpcUrl }));

  async function paint() {
    const session = store.state.session;
    button.disabled = busy;
    if (busy) { button.textContent = copy().text.connecting; return; }
    if (!session) { button.textContent = copy().text.connect; return; }
    button.textContent = copy().shortAddress(session.address);
    try {
      const balance = await session.balance();
      if (store.state.session === session) {
        button.textContent = `${copy().shortAddress(session.address)} · ${copy().ckb(balance)} CKB`;
      }
    } catch {
      // A balance that will not load is not worth an error; the address stays.
    }
  }

  async function connect() {
    if (busy) return null;
    busy = true;
    showNotice("");
    await paint();
    try {
      const session = await ensure().connect();
      await store.setSession(session);
      return session;
    } catch (e) {
      // Said on the page: a console-only failure is invisible to the player.
      showNotice(copy().errors.wallet(e?.message ?? String(e)));
      return null;
    } finally {
      busy = false;
      await paint();
    }
  }

  async function disconnect() {
    menu.hidden = true;
    try { await ensure().disconnect(); } catch { /* already gone */ }
    await store.setSession(null);
    await paint();
  }

  async function restore() {
    try {
      const session = await ensure().restore();
      if (session) await store.setSession(session);
    } catch {
      // No earlier connection to pick up.
    }
    await paint();
  }

  button.addEventListener("click", () => {
    if (store.state.session) menu.hidden = !menu.hidden; else connect();
  });
  el("disconnect").addEventListener("click", disconnect);
  document.addEventListener("click", (event) => {
    if (!menu.hidden && !menu.contains(event.target) && event.target !== button) menu.hidden = true;
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") menu.hidden = true;
  });

  return { connect, restore, paint };
}

function createApp({ manifest, store }) {
  const route = () => window.DaowowRoute.parseRoute(window.location.hash);
  const nav = (to) => {
    const hash = typeof to === "string" ? to : window.DaowowRoute.formatRoute(to);
    if (window.location.hash === hash) render(); else window.location.hash = hash;
  };
  const ctx = { manifest, store, rpc: store.rpc, nav, connect: null };
  let panel = null; // { key, handle }
  let shown = null;

  function dropPanel() {
    if (panel) { try { panel.handle.dispose(); } catch { /* nothing to free */ } }
    panel = null;
  }

  function show(sectionId, tab) {
    for (const section of document.querySelectorAll("main > section")) {
      section.hidden = section.id !== sectionId;
    }
    for (const link of document.querySelectorAll("#tabs .tab")) {
      if (link.dataset.tab === tab) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    if (shown !== sectionId) {
      shown = sectionId;
      window.scrollTo(0, 0);
      // Move focus with the view, so a keyboard or screen-reader user lands
      // in the section they asked for rather than back at the tab bar.
      const heading = el(sectionId).querySelector("h1");
      if (heading) heading.focus({ preventScroll: true });
    }
  }

  function notFound(node) {
    clear(node).append(h("div", { class: "card" },
      h("p", { class: "empty" }, copy().errors.roundNotFound),
      h("a", { class: "secondary-button", href: "#/rounds" }, copy().text.seeRounds)));
  }

  function renderPanel(r) {
    const node = el("panel-body");
    show("view-panel", "rounds");
    const state = store.state;
    if (r.unknown) { dropPanel(); notFound(node); return; }
    if (state.status === "loading") { dropPanel(); clear(node).append(loadingCard()); return; }
    if (state.status === "error" && state.rows.length === 0) {
      dropPanel();
      showRetry(node, copy().errors.network, () => store.refresh(), state.error);
      return;
    }
    const row = store.findRound(r.round);
    if (!row) { dropPanel(); notFound(node); return; }
    const key = `${row.snapshot.config.roundId}/${r.panel}`;
    if (panel && panel.key === key) { panel.handle.update(row); return; }
    dropPanel();
    panel = { key, handle: PANEL_VIEWS[r.panel].mount(node, ctx, row) };
  }

  function renderTab(tab) {
    dropPanel();
    show(`view-${tab}`, tab);
    const view = TAB_VIEWS[tab];
    if (!view) return; // How it works is static
    const node = el(`${tab}-live`);
    const state = store.state;
    if (state.status === "loading") { clear(node).append(loadingCard()); return; }
    if (state.status === "error") {
      showRetry(node, copy().errors.network, () => store.refresh(), state.error);
      return;
    }
    view.render(node, ctx);
  }

  function render() {
    const r = route();
    if (r.unknown || r.panel) renderPanel(r); else renderTab(r.tab);
  }

  return { render, ctx };
}

async function boot() {
  let manifest;
  try {
    manifest = await loadManifest();
  } catch (e) {
    showError(el("home-live"), copy().errors.manifest, e?.message ?? String(e));
    return;
  }
  const rpc = window.DaowowRpc.createRpc(manifest.rpcUrl);
  const store = window.DaowowStore.createStore({ manifest, rpc, readers: readers() });
  store.rpc = rpc;

  const app = createApp({ manifest, store });
  const wallet = createWalletControl({ manifest, store });
  app.ctx.connect = wallet.connect;

  store.subscribe(() => app.render());
  window.addEventListener("hashchange", () => app.render());
  app.render();

  await store.refresh();
  await wallet.restore();

  // Keep the page honest without a reload, but only while someone is looking.
  window.setInterval(() => { if (!document.hidden) store.refresh(); }, REFRESH_MS);
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
}
