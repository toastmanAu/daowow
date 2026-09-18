// Live round view. Reads chain state and renders it; writes nothing.
//
// The chain modules are loaded as classic scripts by index.html and expose
// themselves on window (the pattern core.js and engine.js already use). Only
// the wallet needs to be an ES module, because the vendored CCC bundle is one.

// Only the wallet is imported: it is a real ES module because the vendored
// CCC bundle is one. The rest are classic scripts index.html loads first,
// which publish themselves on window -- importing them here would fail in the
// browser, since they are CommonJS and browsers have no module.exports.
import { createWallet } from "../chain/wallet.js";

const { loadManifest } = window.DaowowManifest;
const { createRpc } = window.DaowowRpc;
const { findRounds, findShards, deriveRoundState, ROUND_STATE } = window.DaowowDiscovery;

const SHANNONS = 100000000n;

const el = (id) => document.getElementById(id);
const text = (node, value) => { node.textContent = value; };

// CKB amounts are BigInt shannons: Number would silently round above 2^53.
function ckb(shannons) {
  const whole = shannons / SHANNONS;
  return whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function stat(label, value, sub) {
  return `<div class="stat"><dt>${label}</dt><dd>${value}` +
    (sub ? `<div class="sub">${sub}</div>` : "") + `</dd></div>`;
}

function renderRound(round, shards, nowEpoch) {
  const c = round.config;
  const s = deriveRoundState(c, shards, nowEpoch);
  const label = { [ROUND_STATE.OPEN]: "Open", [ROUND_STATE.PENDING]: "Not yet open",
    [ROUND_STATE.FROZEN]: "Closed" }[s.state];
  const cap = c.maximumTickets === 0n ? null : c.maximumTickets;
  const pct = cap && cap > 0n ? Number((s.ticketsSold * 100n) / cap) : 0;

  return `<section class="card">
    <div class="card-head">
      <h2>Round ${c.roundId.slice(0, 8)}</h2>
      <span class="state state-${s.state}">${label}</span>
    </div>
    <dl class="grid">
      ${stat("Ticket price", `${ckb(c.ticketPrice)} <span>CKB</span>`)}
      ${stat("Tickets sold", s.ticketsSold.toString(), cap ? `of ${cap} maximum` : "no cap")}
      ${stat("Minimum to draw", c.minimumTickets.toString(),
        s.viable ? "reached" : `${c.minimumTickets - s.ticketsSold} more needed`)}
      ${stat("Entry window", `${c.entryStart}–${c.entryEnd}`, "absolute epochs")}
    </dl>
    ${cap ? `<div class="bar"><i style="width:${Math.min(pct, 100)}%"></i></div>
    <p class="bar-note"><span>${s.ticketsSold} sold</span>
      <span>${s.ticketsRemaining} remaining</span></p>` : ""}
  </section>`;
}

async function init() {
  const params = new URLSearchParams(location.search);
  const manifestUrl = params.get("manifest") ?? "/deployments/testnet-manifest.json";
  const rounds = el("rounds");

  let manifest;
  try {
    const res = await fetch(manifestUrl);
    if (!res.ok) throw new Error(`${res.status} fetching ${manifestUrl}`);
    manifest = loadManifest(await res.json());
  } catch (e) {
    rounds.innerHTML = `<div class="error">Could not load the deployment manifest.
      <code>${e.message}</code></div>`;
    return;
  }

  text(el("net"), manifest.network);
  text(el("rpc"), manifest.rpcUrl);

  const rpc = createRpc(manifest.rpcUrl);
  let nowEpoch = 0n;
  try {
    const tip = await rpc.call("get_tip_header", []);
    // RFC 0017 epoch field: the low 24 bits are the epoch NUMBER; the rest is
    // the index/length fraction within it. Masking is required -- using the
    // raw value would put every round centuries in the future.
    nowEpoch = BigInt(tip.epoch) & 0xffffffn;
    text(el("epoch"), nowEpoch.toString());
  } catch (e) {
    rounds.innerHTML = `<div class="error">Could not reach the node.<code>${e.message}</code></div>`;
    return;
  }

  let found;
  try {
    found = await findRounds(rpc, manifest);
  } catch (e) {
    rounds.innerHTML = `<div class="error">Round discovery failed.<code>${e.message}</code></div>`;
    return;
  }

  if (found.length === 0) {
    rounds.innerHTML = `<div class="card"><p class="empty">No rounds found for the deployed
      contracts. That is the expected result before the first round is created.</p></div>`;
    return;
  }

  const html = [];
  for (const round of found) {
    const shards = await findShards(rpc, manifest, round.config.roundId);
    html.push(renderRound(round, shards, nowEpoch));
  }
  rounds.innerHTML = html.join("");
}

function wireWallet() {
  const button = el("connect");
  let wallet = null;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      // Constructed on demand so a visitor who never connects loads no
      // wallet state at all.
      wallet ??= createWallet({ rpcUrl: el("rpc").textContent });
      const session = await wallet.connect();
      const balance = await session.balance();
      text(button, `${session.address.slice(0, 10)}… · ${ckb(balance)} CKB`);
    } catch (e) {
      text(button, "Connect failed — retry");
      console.error(e);
    } finally {
      button.disabled = false;
    }
  });
}

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", () => { wireWallet(); init(); });
}
