// The entry view's DOM wiring. Rendering logic lives in entry-view.js so the
// wording and figures are testable; this file only moves them into the page.
//
// D6: the signer is invoked ONLY after the visitor has confirmed a total this
// page computed from chain data. They approve our numbers before the wallet,
// which shows a hash, ever sees the transaction.

import { createWallet } from "../chain/wallet.js";
import { ccc } from "../vendor/ccc-joyid.min.mjs";

const el = (id) => document.getElementById(id);
const chain = () => ({
  loadManifest: window.DaowowManifest.loadManifest,
  createRpc: window.DaowowRpc.createRpc,
  ...window.DaowowDiscovery,
  ...window.DaowowSchedule,
  ...window.DaowowQuote,
  ...window.DaowowEntryView,
});

// Errors are rendered as TEXT. Messages can carry a node's words or a URL the
// visitor supplied, and interpolating either into innerHTML is HTML injection
// on a page whose whole job is to be trusted with a wallet.
function showError(node, headline, detail) {
  node.textContent = "";
  const box = document.createElement("div");
  box.className = "error";
  box.append(headline);
  if (detail) {
    const code = document.createElement("code");
    code.textContent = detail;
    box.append(code);
  }
  node.append(box);
}

function renderQuote(rows) {
  const dl = el("quote");
  dl.textContent = "";
  for (const row of rows) {
    const wrap = document.createElement("div");
    if (/total/i.test(row.label)) wrap.className = "total";
    const dt = document.createElement("dt");
    dt.textContent = row.label;
    const dd = document.createElement("dd");
    dd.textContent = row.value;
    const note = document.createElement("p");
    note.className = "note";
    note.textContent = row.note;
    wrap.append(dt, dd, note);
    dl.append(wrap);
  }
}

function renderPayout(payout) {
  el("payout-summary").textContent = payout.summary;
  const list = el("payout");
  list.textContent = "";
  for (const row of payout.rows) {
    const li = document.createElement("li");
    if (row.open) li.classList.add("open");
    if (!row.reachable) li.classList.add("unreachable");
    const place = document.createElement("span");
    place.textContent = `${row.place}${["st", "nd", "rd"][row.place - 1] ?? "th"}`;
    const when = document.createElement("span");
    when.textContent = row.reachable
      ? (row.open ? "paying" : `opens at ${row.opensAt} tickets`)
      : "not reachable in this round";
    const share = document.createElement("span");
    share.textContent = `${row.share}`;
    li.append(place, when, share);
    list.append(li);
  }
}

async function init() {
  const c = chain();
  const params = new URLSearchParams(location.search);
  const requested = params.get("manifest");
  const roundBox = el("round");
  if (requested !== null && !/^\/(?!\/)[^<>"'\\\s]*$/.test(requested)) {
    showError(roundBox, "Refused that manifest location: it must be a same-origin path.");
    return;
  }

  let manifest;
  try {
    const res = await fetch(requested ?? "/deployments/dev-testnet-manifest.json");
    if (!res.ok) throw new Error(`${res.status} fetching the deployment manifest`);
    manifest = c.loadManifest(await res.json());
  } catch (e) {
    showError(roundBox, "Could not load the deployment manifest.", e.message);
    return;
  }
  el("net").textContent = manifest.network;
  el("rpc").textContent = manifest.rpcUrl;

  const rpc = c.createRpc(manifest.rpcUrl);
  let nowEpoch = 0n;
  try {
    const tip = await rpc.call("get_tip_header", []);
    // RFC 0017 packs index and length into the epoch field; the low 24 bits
    // are the epoch NUMBER.
    nowEpoch = BigInt(tip.epoch) & 0xffffffn;
    el("epoch").textContent = nowEpoch.toString();
  } catch (e) {
    showError(roundBox, "Could not reach the node.", e.message);
    return;
  }

  let rounds;
  try {
    rounds = await c.findRounds(rpc, manifest);
  } catch (e) {
    showError(roundBox, "Round discovery failed.", e.message);
    return;
  }
  if (rounds.length === 0) {
    roundBox.textContent = "";
    const card = document.createElement("div");
    card.className = "card";
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent =
      "No round is open yet. Entry becomes available once a round is created.";
    card.append(p);
    roundBox.append(card);
    return;
  }

  const round = rounds[0];
  const shards = await c.findShards(rpc, manifest, round.config.roundId);
  const state = c.deriveRoundState(round.config, shards, nowEpoch);
  const sold = state.ticketsSold;

  // The committed schedule decides payout depth, so it is read from chain
  // like everything else — the client renders the table, never defines it.
  const scheduleBytes = round.config.prizeScheduleHash;
  let sched = null;
  let scheduleError = null;
  try {
    sched = c.decodeSchedule(await fetchSchedule(rpc, round));
  } catch (e) {
    // Stated rather than silently hidden: without an authenticated schedule
    // the payout table cannot be shown, and entry is not offered.
    scheduleError = e.message;
    sched = null;
  }

  roundBox.textContent = "";
  const card = document.createElement("div");
  card.className = "card";
  const h = document.createElement("h2");
  h.textContent = `Round ${round.config.roundId.slice(0, 8)} · ${state.state}`;
  const line = document.createElement("p");
  line.className = "sub";
  line.textContent =
    `${sold} of ${round.config.maximumTickets || "unlimited"} tickets sold` +
    ` · ${scheduleBytes.slice(0, 8)}…`;
  card.append(h, line);
  roundBox.append(card);

  if (!sched) {
    const note = document.createElement("p");
    note.className = "sub";
    note.textContent = `Entry unavailable: ${scheduleError}`;
    card.append(note);
    return;
  }
  if (state.state !== "open") return;
  el("entry").hidden = false;
  wireEntry({ c, round, sched, sold, manifest, rpc, nowEpoch });
}

// The config cell commits to the schedule's HASH, not its bytes: the schedule
// itself travels in the round-creation transaction's witness, where
// creation_schedule reads it from WitnessArgs.output_type.
//
// So the client recovers it the same way — fetch the transaction that created
// the config cell and read that field — then VERIFIES the commitment. Without
// that check a node could serve any schedule and the payout table would be
// whatever it liked. Molecule parsing is left to CCC rather than hand-rolled;
// getting a length prefix wrong here is the exact class of bug the vendored
// library exists to avoid.
async function fetchSchedule(rpc, round) {
  const created = await rpc.call("get_transaction", [round.outPoint.tx_hash]);
  const raw = created?.transaction?.witnesses?.[0];
  if (!raw) throw new Error("the round creation transaction carries no witness");
  const args = ccc.WitnessArgs.fromBytes(ccc.bytesFrom(raw));
  if (!args.outputType) {
    throw new Error("the creation witness carries no prize schedule");
  }
  const bytes = ccc.bytesFrom(args.outputType);
  const commitment = ccc
    .hashCkb(ccc.bytesConcat(ccc.bytesFrom("DAOWOW_PRIZE_SCHEDULE_V1", "utf8"), bytes))
    .replace(/^0x/, "");
  if (commitment !== round.config.prizeScheduleHash) {
    throw new Error("the published schedule does not match the round's commitment");
  }
  return bytes;
}

function wireEntry({ c, round, sched, sold }) {
  const ticketsInput = el("tickets");
  const agree = el("agree");
  const submit = el("submit");
  const cap = round.config.maximumTickets;

  const refresh = () => {
    let tickets;
    try {
      tickets = BigInt(ticketsInput.value || "0");
      if (tickets <= 0n) throw new Error("at least one ticket");
      if (cap !== 0n && sold + tickets > cap) {
        throw new Error(`only ${cap - sold} tickets remain in this round`);
      }
    } catch (e) {
      el("ticket-note").textContent = e.message;
      submit.disabled = true;
      return;
    }
    el("ticket-note").textContent = "";
    const quote = c.quoteEntry({
      config: round.config, schedule: sched,
      lockScript: window.__daowowLock ?? { args: "0x" + "00".repeat(20) },
      tickets, feeShannons: 0n,
    });
    renderQuote(c.describeQuote(quote));
    renderPayout(c.describePayout(sched, sold + tickets, cap));
    submit.disabled = !(agree.checked && window.__daowowLock);
    submit.textContent = window.__daowowLock
      ? `Enter for ${c.formatCkb(quote.total)} CKB`
      : "Connect a wallet to enter";
  };

  ticketsInput.addEventListener("input", refresh);
  agree.addEventListener("change", refresh);
  refresh();
}

function wireWallet() {
  const button = el("connect");
  let wallet = null;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      wallet ??= createWallet({ rpcUrl: el("rpc").textContent });
      const session = await wallet.connect();
      window.__daowowLock = session.lockScript;
      button.textContent = `${session.address.slice(0, 10)}…`;
      el("tickets").dispatchEvent(new Event("input"));
    } catch (e) {
      button.textContent = "Connect failed — retry";
      console.error(e);
    } finally {
      button.disabled = false;
    }
  });
}

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", () => { wireWallet(); init(); });
}
