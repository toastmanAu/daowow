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
  ...window.DaowowEntryTx,
  ...window.DaowowContention,
  ...window.DaowowShardPeaks,
  ...window.DaowowConfirm,
  scriptHash: window.DaowowRefundTx.scriptHash,
});

// The connected wallet, held here rather than on `window` so a page script
// cannot reach the signing capabilities by reading a global.
const walletState = { session: null };

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

// Drawing the round card. Extracted because it is drawn TWICE: once on load
// and again once an entry lands, when the ticket count has moved.
function renderRoundCard(roundBox, round, state, scheduleBytes) {
  roundBox.textContent = "";
  const card = document.createElement("div");
  card.className = "card";
  const h = document.createElement("h2");
  h.textContent = `Round ${round.config.roundId.slice(0, 8)} · ${state.state}`;
  const line = document.createElement("p");
  line.className = "sub";
  line.textContent =
    `${state.ticketsSold} of ${round.config.maximumTickets || "unlimited"} tickets sold` +
    ` · ${scheduleBytes.slice(0, 8)}…`;
  card.append(h, line);
  roundBox.append(card);
  return card;
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

  // ?round=<id prefix> picks a round; otherwise the newest. Never rounds[0]:
  // that is indexer order (by id), not age, and once showed a dead round.
  const wanted = new URLSearchParams(window.location.search).get("round");
  const round = c.selectRound(rounds, wanted);
  if (!round) {
    showError(roundBox, "No unique round matches ?round=.", String(wanted));
    return;
  }
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

  const card = renderRoundCard(roundBox, round, state, scheduleBytes);

  if (!sched) {
    const note = document.createElement("p");
    note.className = "sub";
    note.textContent = `Entry unavailable: ${scheduleError}`;
    card.append(note);
    return;
  }
  if (state.state !== "open") return;
  el("entry").hidden = false;
  wireEntry({ c, round, sched, sold, manifest, rpc, nowEpoch, roundBox, scheduleBytes });
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
  const created = await rpc.call("get_transaction", [round.outPoint.txHash]);
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

function wireEntry({ c, round, sched, sold, manifest, rpc, nowEpoch, roundBox, scheduleBytes }) {
  const ticketsInput = el("tickets");
  const agree = el("agree");
  const submit = el("submit");
  const status = el("status");
  const cap = round.config.maximumTickets;
  let tickets = 0n;
  let ticketsSold = sold;

  const say = (text) => { status.textContent = text; };

  const refresh = () => {
    const asked = c.describeTicketRequest({
      value: ticketsInput.value, ticketsSold, cap,
    });
    el("ticket-note").textContent = asked.note;

    if (asked.tickets === null) {
      tickets = 0n;
      submit.disabled = true;
      // The quote is CLEARED rather than left showing the last valid total: a
      // figure in CKB that no longer corresponds to the input is the one thing
      // on this page a visitor must never misread.
      el("quote").textContent = "";
      submit.textContent = asked.full ? "This round is full" : "Enter a ticket count";
      // The payout table stays, showing the round AS IT STANDS. It used to
      // vanish whenever the input was unusable — including on a full round,
      // which is the moment a visitor most wants to see what it pays.
      renderPayout(c.describePayout(sched, ticketsSold, cap));
      return;
    }

    tickets = asked.tickets;
    const quote = c.quoteEntry({
      config: round.config, schedule: sched,
      lockScript: walletState.session?.lockScript ?? { args: "0x" + "00".repeat(20) },
      tickets, feeShannons: 0n,
    });
    renderQuote(c.describeQuote(quote));
    renderPayout(c.describePayout(sched, ticketsSold + tickets, cap));
    submit.disabled = !(agree.checked && walletState.session);
    submit.textContent = walletState.session
      ? `Enter for ${c.formatCkb(quote.total)} CKB`
      : "Connect a wallet to enter";
  };

  // The shard head, read fresh. Never cached: a cached head is exactly how a
  // client builds an append against a cell another entry already consumed,
  // and the peaks belong to the head that is current NOW.
  const readHead = async () => {
    const shards = await c.findShards(rpc, manifest, round.config.roundId);
    const head = shards[0];
    if (!head) throw new Error("this round's entry shard is no longer on chain");
    return { ...head, peaks: await c.readShardPeaks(rpc, head) };
  };

  // Re-read the round from chain and redraw. Everything here comes from the
  // chain again rather than from arithmetic on what we just sent: a client
  // that predicts the new state is a client that can be wrong about it.
  const refreshRound = async () => {
    const shards = await c.findShards(rpc, manifest, round.config.roundId);
    const tip = await rpc.call("get_tip_header", []);
    const epoch = BigInt(tip.epoch) & 0xffffffn;
    el("epoch").textContent = epoch.toString();
    const state = c.deriveRoundState(round.config, shards, epoch);
    ticketsSold = state.ticketsSold;
    renderRoundCard(roundBox, round, state, scheduleBytes);
    refresh();
  };

  submit.addEventListener("click", async () => {
    const session = walletState.session;
    if (!session || submit.disabled) return;
    submit.disabled = true;
    el("submit-error").textContent = "";
    try {
      say("Reading the current shard head…");
      const { txHash, attempts } = await c.submitEntryWithRetry({
        readHead,
        buildAndSign: async (head) => {
          const built = c.buildEntryTx({
            manifest, config: round.config, schedule: sched, shard: head,
            lock: session.lockScript,
            participantLockHash: c.scriptHash(session.lockScript),
            tickets, nowEpoch, configCellOutPoint: round.outPoint,
          });
          // D6: the wallet is invoked only now, after the visitor confirmed a
          // total this page computed from chain data. JoyID shows a hash; the
          // numbers they actually approved are the ones above.
          say("Approve the entry in your wallet…");
          return await session.signEntry(built.tx);
        },
        broadcast: async (signed) => {
          say("Broadcasting…");
          return await session.broadcast(signed);
        },
      });
      // Committed is NOT claimed here. The node accepted the transaction into
      // its pool; that is all a send return value means. So the page now
      // WATCHES it rather than declaring victory and going stale.
      const sentLine =
        `Sent${attempts > 1 ? ` after ${attempts} attempts` : ""}. ` +
        `Transaction ${txHash}.`;
      say(`${sentLine} Waiting for it to be included in a block…`);

      const landed = await c.awaitCommitted(rpc, txHash, {
        onStatus: (status) => {
          if (status === "proposed") say(`${sentLine} Proposed; waiting for a block…`);
        },
      });
      if (landed.timedOut) {
        // Not a failure, and not claimed as one. We stopped watching; the
        // chain did not stop working.
        say(
          `${sentLine} It is still ${landed.status} after three minutes, so ` +
          "this page has stopped watching. It may yet commit — reload to check.",
        );
        submit.disabled = false;
        return;
      }

      // The indexer trails the chain. Re-reading before it catches up returns
      // the world as it was BEFORE this entry, which reads as the page having
      // done nothing.
      say(`${sentLine} Committed in block ${landed.blockNumber}. Refreshing…`);
      await c.awaitIndexer(rpc, landed.blockNumber);
      await refreshRound();
      say(
        `${sentLine} Committed in block ${landed.blockNumber}. ` +
        `Your ${tickets} ticket${tickets === 1n ? "" : "s"} are in the round.`,
      );
    } catch (e) {
      // Contention that exhausted its retries, a rejection, or a wallet
      // refusal. All three leave the visitor's funds where they were.
      say("");
      showError(el("submit-error"), "The entry was not sent.", e.message);
      submit.disabled = false;
      return;
    }
  });

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
      walletState.session = session;
      button.textContent = `${session.address.slice(0, 10)}…`;
      el("tickets").dispatchEvent(new Event("input"));
    } catch (e) {
      button.textContent = "Connect failed — retry";
      // Say WHY on the page; a console-only error is invisible to the user.
      el("submit-error").textContent = `Wallet connect failed: ${e?.message ?? String(e)}`;
      console.error(e);
    } finally {
      button.disabled = false;
    }
  });
}

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", () => { wireWallet(); init(); });
}
