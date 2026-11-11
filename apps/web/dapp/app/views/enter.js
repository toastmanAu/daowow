// Entering a round, inside the app.
//
// D6 still holds: the wallet is invoked ONLY after the player has confirmed a
// total this page computed from chain data. JoyID shows a hash; the numbers
// the player actually approves are the ones in the summary here.
//
// The sending sequence is the old entry page's, unchanged: read the head
// fresh, build, sign, broadcast with the contention retry, then WATCH the
// transaction rather than assume it landed, and wait for the indexer before
// re-reading.
import { h, clear, errorBox, badge } from "../dom.js";
import { stateTone, progressBar } from "./round-card.js";

const copy = () => window.DaowowCopy;
const JOYID_SHAPED = { args: "0x" + "00".repeat(22) };

function summaryList(rows) {
  return h("dl", { class: "quote" }, rows.map((row) =>
    h("div", { class: /^Total/.test(row.label) ? "total" : "" },
      h("dt", {}, row.label),
      h("dd", {}, row.value),
      h("p", { class: "note" }, row.note))));
}

function termText(row) {
  const t = window.DaowowTime;
  const ms = BigInt(row.snapshot.config.daoTermPeriods)
    * window.DaowowTimeline.PERIODS_PER_TERM * t.EPOCH_MS;
  return copy().heldFor(t.describeDuration(ms));
}

export function mount(node, ctx, firstRow) {
  const words = copy().text.entry;
  const roundId = firstRow.snapshot.config.roundId;
  let row = firstRow;
  let busy = false;
  let finished = false;
  let shownTotal = null; // the total on screen, which is the total that may be signed
  let disposed = false;

  const head = h("div", { class: "card" });
  const input = h("input", {
    id: "tickets", type: "number", inputmode: "numeric", min: "1", value: "1",
    oninput: () => paint(),
  });
  const ticketNote = h("p", { class: "sub", id: "ticket-note" });
  const summary = h("div", {});
  const payout = h("div", { class: "stack-tight" });
  const agree = h("input", { type: "checkbox", id: "agree", onchange: () => paint() });
  const late = h("input", { type: "checkbox", id: "accept-late", onchange: () => paint() });
  const lateLine = h("p", { class: "confirm-line", hidden: true },
    h("label", {}, late, words.acceptLate));
  const submit = h("button", { class: "primary-button", type: "button", onclick: () => onSubmit() });
  const status = h("p", { class: "status", role: "status", "aria-live": "polite" });
  const problem = h("div", {});
  const after = h("div", { class: "actions" });
  const form = h("div", { class: "card" },
    h("h2", {}, words.title),
    h("div", { class: "field" }, h("label", { for: "tickets" }, words.tickets), input, ticketNote),
    h("h3", { class: "section-heading" }, words.summary),
    summary,
    h("h3", { class: "section-heading" }, copy().text.prizeTable),
    payout,
    h("p", { class: "confirm-line" }, h("label", {}, agree, words.agree)),
    lateLine,
    submit, status, problem, after);
  clear(node).append(head, form);

  const say = (text) => { status.textContent = text; };
  const session = () => ctx.store.state.session;

  function paintHead() {
    clear(head).append(
      h("div", { class: "card-head" },
        h("h2", {}, row.label),
        badge(copy().stateBadge(row.view.state, row.view), stateTone(row.view))),
      h("div", { class: "stack-tight" },
        progressBar(row.view),
        h("p", { class: "muted" }, copy().ticketsLine(row.view.ticketsSold, row.view.cap))),
      h("p", {}, copy().milestone({ view: row.view, snapshot: row.snapshot, tip: ctx.store.state.tip })));
  }

  // What the player asked for, judged against the round as it stands.
  function asked() {
    return window.DaowowEntryView.describeTicketRequest({
      value: input.value, ticketsSold: row.view.ticketsSold,
      cap: row.snapshot.config.maximumTickets,
    });
  }

  function paint() {
    if (disposed) return;
    paintHead();
    const view = window.DaowowEntryView;
    const request = asked();
    const guard = window.DaowowEntryGuard.entryProblem({
      view: row.view, snapshot: row.snapshot, schedule: row.schedule, sound: row.sound,
      tickets: request.tickets ?? 1n, nowEpoch: ctx.store.state.tip.epoch.number,
      held: session() ? window.DaowowEntryGuard.heldIn(ctx.store.state.mine, roundId) : undefined,
    });
    // One reason at a time: when the round itself is the problem, say that.
    ticketNote.textContent = guard.block ? "" : request.note;
    input.disabled = busy || finished;
    agree.disabled = busy || finished;
    late.disabled = busy || finished;
    lateLine.hidden = !guard.warn;

    clear(payout);
    if (row.schedule) {
      const sold = row.view.ticketsSold + (request.tickets ?? 0n);
      const table = view.describePayout(row.schedule, sold, row.snapshot.config.maximumTickets);
      payout.append(
        h("p", {}, table.summary),
        h("ol", { class: "plain-list" }, table.rows.filter((r) => r.reachable).map((r) =>
          h("li", { class: r.open ? "" : "muted" },
            copy().placeLine(r.place, r.share, r.opensAt, r.open, r.reachable)))));
    }

    clear(summary);
    shownTotal = null;
    // A round that cannot take this entry shows why, and no total: a figure
    // in CKB that no longer matches the request is the one thing on this
    // screen a player must never misread.
    if (guard.block || request.tickets === null || !row.schedule) {
      if (guard.block) summary.append(h("p", { class: "muted" }, guard.block));
      submit.disabled = true;
      submit.textContent = session() ? copy().text.enter : words.connectToEnter;
      if (!session() && !guard.block) submit.disabled = busy;
      return;
    }

    const quote = window.DaowowQuote.quoteEntry({
      config: row.snapshot.config, schedule: row.schedule,
      lockScript: session()?.lockScript ?? JOYID_SHAPED,
      tickets: request.tickets, feeShannons: 0n,
    });
    summary.append(summaryList(view.describeQuote(quote, { term: termText(row) })));
    shownTotal = quote.total;
    if (finished) { submit.hidden = true; return; }
    if (!session()) {
      submit.disabled = busy;
      submit.textContent = words.connectToEnter;
      return;
    }
    submit.textContent = copy().enterFor(view.formatCkb(quote.total));
    submit.disabled = busy || !agree.checked || (Boolean(guard.warn) && !late.checked);
  }

  async function send(fresh, tickets, who, beforeSign) {
    const { manifest, rpc } = ctx;
    const config = fresh.snapshot.config;
    // The shard head, read fresh on every attempt. Never cached: a cached
    // head is exactly how a client builds on a cell another entry already
    // consumed, and the peaks belong to the head that is current NOW.
    const readHead = async () => {
      const shards = await window.DaowowDiscovery.findShards(rpc, manifest, config.roundId);
      const shard = shards[0];
      if (!shard) throw new Error("this round's entry shard is no longer on chain");
      return { ...shard, peaks: await window.DaowowShardPeaks.readShardPeaks(rpc, shard) };
    };
    return window.DaowowContention.submitEntryWithRetry({
      readHead,
      buildAndSign: async (shard) => {
        const built = window.DaowowEntryTx.buildEntryTx({
          manifest, config, schedule: fresh.schedule, shard,
          lock: who.lockScript,
          participantLockHash: window.DaowowRefundTx.scriptHash(who.lockScript),
          tickets, nowEpoch: ctx.store.state.tip.epoch.number,
          configCellOutPoint: fresh.snapshot.outPoint,
        });
        // Stops here if the player has left this screen: a screen nobody is
        // looking at must not open their wallet.
        beforeSign();
        say(words.approve);
        return who.signEntry(built.tx);
      },
      broadcast: async (signed) => {
        say(words.sending);
        return who.broadcast(signed);
      },
    });
  }

  function showHash(txHash) {
    after.append(h("details", {}, h("summary", {}, copy().text.technical),
      h("p", { class: "muted" }, `${words.transaction}: `, h("span", { class: "mono" }, txHash))));
  }

  async function onSubmit() {
    if (busy || finished) return;
    // The wallet that will sign, taken once, now. Everything from here on
    // uses this one session, so a wallet swapped mid-flow cannot sign a total
    // that was quoted for another.
    const who = ctx.signing();
    if (!who) {
      await ctx.connect();
      paint();
      return;
    }
    const request = asked();
    if (request.tickets === null || shownTotal === null) return;
    const confirmedTotal = shownTotal;
    busy = true;
    clear(problem);
    clear(after);
    paint();

    const lines = { checking: words.checking, waiting: words.waiting };
    // The sequence itself lives in model/send-flow.js, where it is tested:
    // re-read before the wallet opens, never sign for a screen the player has
    // left, and never say "not sent" about a transaction that was broadcast.
    const outcome = await window.DaowowSendFlow.runEntry({
      check: () => window.DaowowEntryGuard.checkBeforeSigning({
        store: ctx.store, roundId, tickets: request.tickets, acceptLate: late.checked,
        lockScript: who.lockScript, shownTotal: confirmedTotal,
      }),
      isLive: () => !disposed,
      send: (fresh, beforeSign) => send(fresh, request.tickets, who, beforeSign),
      watch: (txHash) => {
        showHash(txHash);
        return window.DaowowSendFlow.watchTransaction({ rpc: ctx.rpc, txHash });
      },
      say: (stage) => say(lines[stage] ?? ""),
    });

    busy = false;
    if (outcome.stage === "refused") {
      say("");
      problem.append(errorBox(outcome.message));
    } else if (outcome.stage === "not-sent") {
      // The wallet said no, the broadcast failed, or the round was too busy.
      // All three leave the player's funds where they were.
      say("");
      problem.append(errorBox(words.notSent, outcome.detail));
    } else if (outcome.stage === "rejected") {
      say("");
      problem.append(errorBox(words.rejected, outcome.detail));
    } else if (outcome.stage === "pending") {
      // Sent, not yet confirmed. The form stays locked: pressing Enter again
      // here is how someone pays twice.
      finished = true;
      say(words.pending);
    } else if (outcome.stage === "confirmed") {
      finished = true;
      await ctx.store.refresh();
      say(copy().entryConfirmed(request.tickets));
      after.append(h("a", { class: "primary-button", href: "#/tickets" }, words.seeTickets));
    }
    // If the player moved on while this was in flight, the outcome still has
    // to reach them, wherever they are now.
    if (disposed && outcome.txHash) {
      ctx.notice(outcome.stage === "confirmed"
        ? copy().entryConfirmed(request.tickets) : words.sentElsewhere);
    }
    paint();
  }

  paint();
  return {
    update(next) { row = next; paint(); },
    dispose() { disposed = true; },
  };
}
