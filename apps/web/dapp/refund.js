// The refund view's DOM wiring.
//
// A refund is the one place this interface tells someone their money is
// STUCK rather than available, so the wording matters more than usual. Four
// distinct things can block a refund and the chain reports one error code for
// all of them, so refundBlocker returns the reason and this page shows it
// verbatim instead of a generic "not available".

import { createWallet } from "../chain/wallet.js";

const el = (id) => document.getElementById(id);
const chain = () => ({
  loadManifest: window.DaowowManifest.loadManifest,
  createRpc: window.DaowowRpc.createRpc,
  ...window.DaowowDiscovery,
  ...window.DaowowRefundTx,
  ...window.DaowowConfirm,
});

// Held here rather than on `window` so a page script cannot reach the signing
// capabilities by reading a global.
const walletState = { session: null };

// Errors are rendered as TEXT: messages can carry a node's words, and
// interpolating those into innerHTML is HTML injection on a page trusted with
// a wallet.
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

const CKB = 100000000n;
const formatCkb = (shannons) => {
  const whole = BigInt(shannons) / CKB;
  return whole.toLocaleString("en-US");
};

function renderRound(node, round, ledger) {
  node.textContent = "";
  const card = document.createElement("div");
  card.className = "card";
  const h = document.createElement("h2");
  h.textContent = `Round ${round.config.roundId.slice(0, 8)}`;
  const line = document.createElement("p");
  line.className = "sub";
  // The ledger's state is the whole story for a refund, so it is stated first
  // and in plain terms rather than left to be inferred from a button.
  if (!ledger) {
    line.textContent =
      "This round has no aggregation ledger yet. Until the round is frozen and " +
      "its ledger closed, no entry can be refunded — the deadline passing is " +
      "not enough on its own.";
  } else if (!ledger.state.closed) {
    line.textContent =
      `The ledger is open: ${ledger.state.acceptedEntries} of ` +
      `${ledger.state.frozen.entryCount} entries accepted so far. It must be ` +
      "closed before an unaccepted entry can be released.";
  } else {
    const accepted = ledger.state.acceptedEntries;
    const total = ledger.state.frozen.entryCount;
    line.textContent =
      `The ledger is closed. ${accepted} of ${total} entries were accepted ` +
      `and take part in the draw; the other ${total - accepted} can be refunded.`;
  }
  card.append(h, line);
  node.append(card);
}

function renderEntries({ c, round, ledger, entries, allEntries, nowEpoch, manifest, rpc }) {
  const list = el("entry-list");
  list.textContent = "";
  const mine = walletState.session
    ? entries.filter((e) => e.participantLockHash === myLockHash())
    : [];

  el("entries-note").textContent = walletState.session
    ? (mine.length === 0
        ? "No entries in this round under the connected wallet."
        : `${mine.length} entr${mine.length === 1 ? "y" : "ies"} found.`)
    : "Connect a wallet to see your entries.";

  for (const cell of mine) {
    const li = document.createElement("li");
    const head = document.createElement("div");
    head.className = "entry-head";
    const who = document.createElement("span");
    who.textContent = `Entry #${cell.entry.entryNonce} · ` +
      `${cell.entry.ticketCount} ticket${cell.entry.ticketCount === 1n ? "" : "s"}`;
    const amount = document.createElement("span");
    amount.className = "mono";
    amount.textContent = `${formatCkb(cell.capacity)} CKB`;
    head.append(who, amount);

    const why = c.refundBlocker({
      config: round.config, nowEpoch,
      ledger: ledger ? ledger.state : null,
      entryNonce: cell.entry.entryNonce,
    });

    const note = document.createElement("p");
    note.className = "sub";
    li.append(head, note);

    if (why) {
      // Shown verbatim: the reason is the useful part, and there are four of
      // them behind one on-chain error code.
      note.textContent = why;
      li.classList.add("unreachable");
    } else {
      note.textContent =
        "Refundable. The full amount returns to this wallet; the network fee " +
        "is funded separately from your balance.";
      const button = document.createElement("button");
      button.className = "primary-button";
      button.type = "button";
      button.textContent = `Refund ${formatCkb(cell.capacity)} CKB`;
      button.addEventListener("click", () => refund({
        c, round, ledger, cell, allEntries, nowEpoch, manifest, rpc, button,
      }));
      li.append(button);
    }
    list.append(li);
  }
  el("entries").hidden = false;
}

function myLockHash() {
  const lock = walletState.session?.lockScript;
  if (!lock) return null;
  return window.DaowowRefundTx.scriptHash(lock);
}

async function refund({ c, round, ledger, cell, allEntries, nowEpoch, manifest, rpc, button }) {
  const session = walletState.session;
  if (!session) return;
  button.disabled = true;
  el("refund-error").textContent = "";
  const say = (text) => { el("status").textContent = text; };
  try {
    const built = c.buildRefundTx({
      manifest, config: round.config,
      entryCell: cell,
      participantLock: session.lockScript,
      participantLockHash: cell.participantLockHash,
      nowEpoch,
      configCellOutPoint: round.outPoint,
      ledgerCell: ledger,
      allEntries,
      // No sponsor: the wallet funds the fee and its change lands under this
      // same lock, which is what keeps entry-lock's `returned >= required`
      // satisfied.
    });
    say("Approve the refund in your wallet…");
    const signed = await session.signEntry(built.tx);
    say("Broadcasting…");
    const txHash = await session.broadcast(signed);
    say(`Sent. Transaction ${txHash}. Waiting for it to be included in a block…`);
    const landed = await c.awaitCommitted(rpc, txHash);
    if (landed.timedOut) {
      say(
        `Sent. Transaction ${txHash}. It is still ${landed.status} after three ` +
        "minutes, so this page has stopped watching. It may yet commit — " +
        "reload to check.",
      );
      return;
    }
    say(`Refunded in block ${landed.blockNumber}. ` +
      `${formatCkb(cell.capacity)} CKB is back in your wallet.`);
    await c.awaitIndexer(rpc, landed.blockNumber);
    await init();
  } catch (e) {
    say("");
    showError(el("refund-error"), "The refund was not sent.", e.message);
    button.disabled = false;
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
    p.textContent = "No round on chain, so there is nothing to refund.";
    card.append(p);
    roundBox.append(card);
    return;
  }

  const round = rounds[0];
  const commitment = round.config.commitment;
  let ledger = null;
  let allEntries = [];
  try {
    ledger = await c.findLedger(rpc, manifest, commitment);
    // EVERY entry of the shard, not only the connected wallet's: the exclusion
    // proof is a membership proof against the frozen accumulator, and that
    // means replaying the whole shard. The accumulator's root is on chain and
    // its proof paths are not.
    allEntries = await c.findEntries(rpc, manifest, commitment);
  } catch (e) {
    showError(roundBox, "Could not read the round's ledger or entries.", e.message);
    return;
  }

  renderRound(roundBox, round, ledger);
  renderEntries({
    c, round, ledger, entries: allEntries,
    allEntries: allEntries.map((x) => x.entry),
    nowEpoch, manifest, rpc,
  });
}

function wireWallet() {
  const button = el("connect");
  let wallet = null;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      wallet ??= createWallet({ rpcUrl: el("rpc").textContent });
      const session = await wallet.connect();
      walletState.session = session;
      button.textContent = `${session.address.slice(0, 10)}…`;
      await init();
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
