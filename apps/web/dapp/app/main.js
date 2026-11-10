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

// The network's own Nervos DAO type, as a script hash, asked of the node once.
// get_consensus reports the DAO's CODE hash; a round's config commits the hash
// of the whole type SCRIPT (the 2026-10-05 trap), so it is built here.
function daoTypeHashOnce(rpc) {
  let pending = null;
  return () => {
    pending ??= rpc.call("get_consensus", []).then((consensus) => {
      if (!consensus || !consensus.dao_type_hash) throw new Error("the node did not report the DAO type");
      return window.DaowowRefundTx.scriptHash({
        codeHash: consensus.dao_type_hash, hashType: "type", args: "0x",
      });
    });
    // A failed read is retried on the next refresh rather than cached.
    pending.catch(() => { pending = null; });
    return pending;
  };
}

function readers(manifest, rpc) {
  const cells = window.DaowowRoundCells;
  const daoTypeHash = daoTypeHashOnce(rpc);
  return {
    isTrustedRound: (config) => cells.matchesDeployment(config, manifest),
    isSoundRound: async (config) => cells.usesNetworkDao(config, await daoTypeHash()),
    readTip: (rpc) => rpc.call("get_tip_header", []),
    readIndexerTip: async (r) => BigInt((await r.call("get_indexer_tip", [])).block_number),
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
    h("button", { class: "link-button", type: "button", onclick: () => showNotice("") },
      copy().text.dismiss));
}

// The wallet pill. The store is told WHO is connected. The session that can
// sign stays here, in this closure, and is handed only to the two views that
// send transactions. Nothing is hung on `window`.
function createWalletControl({ manifest, store }) {
  const button = el("wallet");
  const menu = el("wallet-menu");
  let wallet = null;
  let busy = false;
  let signer = null; // the full session: signEntry and broadcast live here
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
      signer = session;
      await store.setSession(session);
      return store.state.session;
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
    signer = null;
    await store.setSession(null);
    await paint();
  }

  async function restore() {
    try {
      const session = await ensure().restore();
      if (session) { signer = session; await store.setSession(session); }
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

  // The signing session, but only while it is the wallet the page is showing.
  const signing = () => {
    const shown = store.state.session;
    if (!signer || !shown || signer.address !== shown.address) return null;
    return signer;
  };

  return { connect, restore, paint, signing };
}

function createApp({ manifest, store }) {
  const route = () => window.DaowowRoute.parseRoute(window.location.hash);
  // What every view receives. It carries no wallet and no way to sign.
  const ctx = { manifest, store, rpc: store.rpc, connect: null, notice: showNotice };
  // The means to sign, held in this closure and added only to the object the
  // entry and refund views are given.
  let walletSigning = null;
  const signingCtx = () => ({ ...ctx, signing: () => (walletSigning ? walletSigning() : null) });
  const SIGNING_PANELS = ["enter"];
  const SIGNING_TABS = ["tickets"];
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
      showRetry(node, copy().errors.network, retry, state.error);
      return;
    }
    const row = store.findRound(r.round);
    if (!row) { dropPanel(); notFound(node); return; }
    const key = `${row.snapshot.config.roundId}/${r.panel}`;
    if (panel && panel.key === key) { panel.handle.update(row); return; }
    dropPanel();
    const given = SIGNING_PANELS.includes(r.panel) ? signingCtx() : ctx;
    panel = { key, handle: PANEL_VIEWS[r.panel].mount(node, given, row) };
  }

  function renderTab(tab) {
    dropPanel();
    show(`view-${tab}`, tab);
    const view = TAB_VIEWS[tab];
    if (!view) return; // How it works is static
    const node = el(`${tab}-live`);
    const state = store.state;
    if (state.status !== "ready") {
      // Nothing from an earlier read stays on screen beside a loading or
      // error card: old figures next to "can't reach the network" read as current.
      if (view.reset) view.reset();
      if (state.status === "loading") { clear(node).append(loadingCard()); return; }
      showRetry(node, copy().errors.network, retry, state.error);
      return;
    }
    view.render(node, SIGNING_TABS.includes(tab) ? signingCtx() : ctx);
  }

  // Retry shows that it is trying: the card goes back to "Loading" at once.
  function retry() {
    store.state.status = "loading";
    render();
    store.refresh();
  }

  let lagShown = false;
  function render() {
    // Say once when the network's picture is old, and take it down when it is not.
    if (store.state.lagging !== lagShown) {
      lagShown = store.state.lagging;
      showNotice(lagShown ? copy().errors.lagging : "");
    }
    const r = route();
    if (r.unknown || r.panel) renderPanel(r); else renderTab(r.tab);
  }

  return { render, ctx, setSigning(fn) { walletSigning = fn; } };
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
  const store = window.DaowowStore.createStore({ manifest, rpc, readers: readers(manifest, rpc) });
  store.rpc = rpc;

  const app = createApp({ manifest, store });
  const wallet = createWalletControl({ manifest, store });
  app.ctx.connect = wallet.connect;
  app.setSigning(wallet.signing);

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
