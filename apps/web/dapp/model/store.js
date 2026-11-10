"use strict";
// Wrapped in an IIFE: loaded as a classic script these files share one
// global scope, so top-level declarations would collide between modules.
(function () {
// The app's one shared state.
//
// The old pages each connected a wallet and each read the chain for
// themselves. Here there is one read and one session, and every tab renders
// from the same snapshot.
//
// Nothing is stored that the chain can change: refresh() re-derives every
// round's state from the cells it finds. The single exception is a round's
// prize schedule, which its config commits to and so can never change.
//
// All input and output goes through `readers`, injected by the page. That is
// what lets the tests play a slow, failing or lying node against this file.

const lib = (path, name) => (typeof require === "function" ? require(path) : window[name]);
const roundState = () => lib("./round-state.js", "DaowowRoundState");
const ticketsLib = () => lib("./tickets.js", "DaowowTickets");
const time = () => lib("./time.js", "DaowowTime");
const scheduleLib = () => lib("../../chain/schedule.js", "DaowowSchedule");
const drawLib = () => lib("../../chain/draw.js", "DaowowDraw");
const entropy = () => lib("../../chain/entropy-derive.js", "DaowowEntropyDerive");

const message = (e) => (e && e.message ? e.message : String(e));

function createStore({ manifest, rpc, readers }) {
  const state = {
    status: "loading",
    error: null,
    tip: null,
    rows: [],
    session: null,
    mine: null,
    mineError: null,
  };
  const listeners = new Set();
  const schedules = new Map(); // roundId -> decoded schedule; committed, so kept
  let queue = Promise.resolve();

  const notify = () => { for (const fn of [...listeners]) fn(state); };

  // The draw for a round whose result exists. Returns { draw, drawError,
  // drawHeight }. Every path that cannot be CONFIRMED ends with no draw.
  async function readDraw(snapshot, schedule) {
    const onChain = snapshot.record ? snapshot.record.record : null;
    const seal = onChain ? onChain.seal : snapshot.seal.seal;
    const inclusionHeight = onChain ? onChain.inclusionHeight : snapshot.seal.inclusionHeight;
    const drawHeight = entropy().lastEntropyHeight(inclusionHeight);
    try {
      const headers = await readers.readEntropyHeaders(rpc, inclusionHeight);
      if (!headers) throw new Error("the blocks this result depends on are not available");
      // Built here from the block hashes, not taken from the operator.
      const derived = entropy().deriveEntropyRecord({ seal, ...headers });
      if (onChain && !entropy().recordsAgree(derived, onChain)) {
        throw new Error("the posted result does not match the blocks it should come from");
      }
      const draw = drawLib().computeDraw({ config: snapshot.config, record: derived, schedule });
      return { draw, drawError: null, drawHeight };
    } catch (e) {
      return { draw: null, drawError: message(e), drawHeight };
    }
  }

  async function readSchedule(snapshot) {
    const id = snapshot.config.roundId;
    if (schedules.has(id)) return { schedule: schedules.get(id), scheduleError: null };
    try {
      const schedule = scheduleLib().decodeSchedule(await readers.readSchedule(rpc, snapshot));
      schedules.set(id, schedule);
      return { schedule, scheduleError: null };
    } catch (e) {
      return { schedule: null, scheduleError: message(e) };
    }
  }

  async function buildRow(snapshot, label, tip, entryCounts) {
    const S = roundState().PLAYER_STATE;
    const entropyReady = Boolean(snapshot.seal)
      && tip.height >= entropy().lastEntropyHeight(snapshot.seal.inclusionHeight);
    const view = roundState().derivePlayerState({
      snapshot, nowEpoch: tip.epoch.number, entropyReady,
      liveEntryCount: entryCounts.get(snapshot.config.commitment) ?? 0,
    });
    const { schedule, scheduleError } = await readSchedule(snapshot);

    let drawn = { draw: null, drawError: null, drawHeight: null };
    if (view.state === S.DRAWN) {
      drawn = schedule
        ? await readDraw(snapshot, schedule)
        : { draw: null, drawError: scheduleError, drawHeight: null };
    }

    // A deposit exists only once the round has been taken in. A failure here
    // costs one figure, not the page.
    let pool = null;
    if (snapshot.ledger || snapshot.seal || snapshot.record) {
      try { pool = await readers.readPoolSoFar(rpc, snapshot.config, tip.header); } catch { pool = null; }
    }
    // A draw that names nobody (the round fell short) is a round that did not
    // run. Calling it "drawn" would promise winners that do not exist.
    const shown = drawn.draw && !drawn.draw.viable
      ? Object.freeze({ ...view, state: S.FINISHED })
      : view;
    // Sound = it can ever run. Unknown counts as no: an entry is never
    // offered on the strength of a check that did not happen.
    let sound = false;
    try { sound = Boolean(await readers.isSoundRound(snapshot.config)); } catch { sound = false; }
    return { snapshot, view: shown, label, sound, schedule, scheduleError, ...drawn, pool };
  }

  async function loadMine(rows, tip, session) {
    const lockHash = readers.scriptHash(session.lockScript);
    const [claims, entries] = await Promise.all([
      readers.findClaims(rpc, manifest, session.lockScript),
      readers.findMyEntries(rpc, manifest, lockHash),
    ]);
    const draws = new Map();
    for (const row of rows) if (row.draw) draws.set(row.snapshot.config.commitment, row.draw);
    return ticketsLib().buildMyTickets({
      rows, claims, entries, draws, nowEpoch: tip.epoch.number,
    });
  }

  async function refreshMine() {
    const session = state.session;
    if (!session || !state.tip) { state.mine = null; state.mineError = null; return; }
    let mine = null;
    let error = null;
    try {
      mine = await loadMine(state.rows, state.tip, session);
    } catch (e) {
      error = message(e);
    }
    // The wallet changed while this was loading: these are someone else's
    // tickets now, and must not be shown under the new wallet.
    if (state.session !== session) return;
    state.mine = mine;
    state.mineError = error;
  }

  async function readAll() {
    try {
      const header = await readers.readTip(rpc);
      const tip = {
        height: BigInt(header.number), epoch: time().parseEpoch(header.epoch), header,
      };
      const [found, entryCounts] = await Promise.all([
        readers.readDeployment(rpc, manifest), readers.countEntries(rpc, manifest),
      ]);
      // Only rounds built on this deployment's own contracts. Anyone can
      // create a round cell; one that points at other scripts is not ours
      // and is never listed, linked to, or signed for.
      const snapshots = [];
      for (const snapshot of found) {
        if (await readers.isTrustedRound(snapshot.config)) snapshots.push(snapshot);
      }
      const labels = roundState().roundLabels(snapshots);
      const rows = [];
      for (const snapshot of snapshots) {
        rows.push(await buildRow(snapshot, labels.get(snapshot.config.roundId), tip, entryCounts));
      }
      state.tip = tip;
      state.rows = rows;
      state.status = "ready";
      state.error = null;
      await refreshMine();
    } catch (e) {
      state.status = "error";
      state.error = message(e);
    }
    notify();
  }

  /**
   * Re-reads everything. Never throws: a failure becomes status "error".
   *
   * Refreshes run ONE AT A TIME, and the promise a caller gets settles only
   * after a read that STARTED after their call. "Read the round again before
   * signing" depends on that: a refresh that returned early because another
   * was already running would hand back state up to a minute old.
   */
  function refresh() {
    queue = queue.then(readAll, readAll);
    return queue;
  }

  // WHO is connected, and nothing that can sign. Every view can read the
  // store, so the signing operations are deliberately not kept in it; the
  // page hands those only to the two views that send transactions.
  async function setSession(session) {
    state.session = session
      ? Object.freeze({
        address: session.address, lockScript: session.lockScript, balance: session.balance,
      })
      : null;
    state.mine = null;
    state.mineError = null;
    notify();
    if (session && state.status === "ready") {
      await refreshMine();
      notify();
    }
  }

  /** The round a link names: a UNIQUE id prefix, or null. Never another round. */
  function findRound(prefix) {
    const want = String(prefix ?? "").toLowerCase().replace(/^0x/, "");
    if (!/^[0-9a-f]{8,64}$/.test(want)) return null;
    const hits = state.rows.filter((r) => r.snapshot.config.roundId.toLowerCase().startsWith(want));
    return hits.length === 1 ? hits[0] : null;
  }

  /** The newest round, by entry start. Never by the node's own order. */
  function currentRound() {
    return state.rows.length === 0 ? null : state.rows[state.rows.length - 1];
  }

  return {
    state,
    refresh,
    setSession,
    findRound,
    currentRound,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

const api = { createStore };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowStore = api;
})();
