// DAOWOW local round model — UI driver.
// Drives DaowowEngine (the client-side mirror of protocol v0.2) and renders
// every stage, capacity movement and mirrored on-chain rejection.
// Zero dependencies; runs from file://.

"use strict";

(function () {
  const { STAGES, prizeSchedule, SHANNONS } = DaowowEngine;
  const SH = SHANNONS;

  // ------------------------------------------------------------------
  // state
  // ------------------------------------------------------------------
  let engine = null;
  let busy = false;
  let revealCount = 0;          // winners revealed so far (staggered)
  let revealTimer = null;
  let advLines = [];            // adversarial attempt log
  let draft = [];               // [{name, tickets, secret}]
  let blockHashes = [];         // simulated future chain entropy (hex)

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const trunc = (h, n = 8) => (h && h.length > 2 * n ? h.slice(0, n) + "…" + h.slice(-n) : h || "—");

  function fmtCkb(sh) { // trimmed decimals, thousands separators
    sh = BigInt(sh);
    const i = sh / SH;
    let f = (sh % SH).toString().padStart(8, "0").replace(/0+$/, "");
    return i.toLocaleString("en-US") + (f ? "." + f : "");
  }
  function fmtCkbFull(sh) {
    sh = BigInt(sh);
    return (sh / SH).toLocaleString("en-US") + "." + (sh % SH).toString().padStart(8, "0");
  }
  const fmtSh = (sh) => BigInt(sh).toLocaleString("en-US");
  const fmtCycles = (c) => BigInt(c || 0n).toLocaleString("en-US");

  function randHex32() {
    const b = new Uint8Array(32);
    (self.crypto && crypto.getRandomValues) ? crypto.getRandomValues(b) : b.forEach((_, i) => b[i] = Math.floor(Math.random() * 256));
    return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  }
  const rerollHashes = () => { blockHashes = [randHex32(), randHex32(), randHex32()]; };
  rerollHashes();

  // ------------------------------------------------------------------
  // toasts
  // ------------------------------------------------------------------
  function toast(html, kind = "success", code = null, note = null, ms = 4200) {
    const el = document.createElement("div");
    el.className = "toast " + kind;
    el.innerHTML = (code !== null ? `<span class="t-code">script error ${code}</span>` : "") + html + (note ? `<span class="t-note">${note}</span>` : "");
    $("toasts").appendChild(el);
    setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 450); }, ms);
  }

  // ------------------------------------------------------------------
  // guard helper for engine calls
  // ------------------------------------------------------------------
  function attempt(fn, okMsg) {
    if (busy) return;
    try {
      fn();
      if (okMsg) toast(okMsg);
      render();
    } catch (err) {
      toast(esc(err.message), "error", err.code ?? "?", "mirrors the on-chain script rejection");
    }
  }

  // ------------------------------------------------------------------
  // core-verification badge (JS core vs Rust vectors)
  // ------------------------------------------------------------------
  (function coreBadge() {
    const el = $("core-badge");
    try {
      const checks = DaowowCore.selfTest(DAOWOW_VECTORS);
      const pass = checks.filter((c) => c.ok).length;
      if (pass === checks.length) {
        el.textContent = `JS core ≡ Rust vectors (${pass}/${checks.length})`;
        el.classList.add("badge-ok");
        el.title = checks.map((c) => (c.ok ? "✓ " : "✗ ") + c.name).join("\n");
      } else {
        el.textContent = `core check FAILED (${pass}/${checks.length})`;
        el.classList.add("badge-bad");
      }
    } catch (e) {
      el.textContent = "core check error";
      el.classList.add("badge-bad");
      el.title = String(e);
    }
  })();

  // ------------------------------------------------------------------
  // stepper
  // ------------------------------------------------------------------
  function renderStepper() {
    const stage = engine ? engine.stage : "CREATED";
    const activeIdx = STAGES.indexOf(stage);
    let html = "";
    STAGES.forEach((s, i) => {
      const cls = i < activeIdx ? "done" : i === activeIdx ? "active" : "";
      html += `<span class="step ${cls}"><span class="dot"></span>${s}</span>`;
      if (i < STAGES.length - 1) html += `<span class="step-sep">→</span>`;
    });
    $("stepper").innerHTML = html;
  }

  // ------------------------------------------------------------------
  // config panel
  // ------------------------------------------------------------------
  function renderConfig() {
    const has = !!engine;
    ["cfg-name", "cfg-price", "cfg-shards", "cfg-mintickets", "cfg-keeper", "cfg-yield", "cfg-batch"].forEach((id) => ($(id).disabled = has));
    $("btn-create").disabled = has || busy;
    $("btn-create").innerHTML = has ? "Round created ✓" : "Create round&nbsp;(TX-01)";
    $("btn-add-participant").disabled = has;
    $("btn-demo-participants").disabled = has;
    const box = $("draft-participants");
    box.innerHTML = draft.map((p, i) => `
      <div class="draft-row">
        <label>name <input type="text" data-i="${i}" data-f="name" value="${esc(p.name)}" ${has ? "disabled" : ""}></label>
        <label>tickets <span class="unit">×price</span><input type="number" min="1" step="1" data-i="${i}" data-f="tickets" value="${esc(p.tickets)}" ${has ? "disabled" : ""}></label>
        <label class="secret-l">secret <input type="text" data-i="${i}" data-f="secret" value="${esc(p.secret)}" ${has ? "disabled" : ""}></label>
        <span></span>
      </div>`).join("") || `<div class="empty">no participants — add some or load the demo set</div>`;
  }

  function readDraft(ev) {
    const t = ev.target;
    const i = Number(t.dataset.i), f = t.dataset.f;
    if (f === "tickets") draft[i].tickets = Math.max(1, Math.floor(Number(t.value) || 1));
    else draft[i][f] = t.value;
  }

  // ------------------------------------------------------------------
  // actions panel
  // ------------------------------------------------------------------
  function actionRow({ title, sub, btnLabel, btnId, disabled, done, next, extra }) {
    return `
      <div class="action-row ${next ? "next" : ""} ${done ? "done" : ""}">
        <div class="a-info"><div class="a-title">${title}</div><div class="a-sub">${sub}</div>${extra || ""}</div>
        <button class="btn ${next ? "primary" : ""} small" id="${btnId}" ${disabled ? "disabled" : ""}>${btnLabel}</button>
      </div>`;
  }

  function renderActions() {
    const body = $("actions-body");
    $("btn-autorun").disabled = !engine || busy || engine.stage === "COMPLETE";
    if (!engine) {
      body.innerHTML = `<div class="locked-note">Configure the round and press <strong>Create round</strong> to open the entry window.</div>`;
      return;
    }
    const st = engine.stage;
    const enteredCount = engine.entries.length;
    const waiting = [...engine.participants.values()].filter((p) => p.entries.length === 0 && !p.refunded).length;
    const totalTickets = engine.shardData.reduce((a, s) => a + s.ticketCount, 0);
    const minOk = BigInt(totalTickets) >= engine.minTickets;
    let rows = "";

    if (st === "OPEN") {
      rows += actionRow({
        title: "Freeze shards", next: true, btnId: "btn-freeze", disabled: busy || !minOk,
        btnLabel: "Freeze (TX-03)",
        sub: minOk
          ? `ends the entry window · ${fmtSh(totalTickets)} tickets accepted`
          : `needs ${engine.minTickets} tickets, has ${totalTickets}`,
        extra: `<div class="pos-note">refund path stays open per entry until this point</div>`,
      });
      if (waiting > 0) rows += actionRow({
        title: "Enter remaining participants", btnId: "btn-enter-all", disabled: busy,
        btnLabel: `Enter ${waiting}`, sub: `${enteredCount} entries accepted so far · one entry tx per participant`,
      });
    }
    if (st === "FROZEN") {
      const pending = engine.entries.filter((e) => !e.aggregated).length;
      const batch = Math.max(1, Math.floor(Number($("cfg-batch").value) || 3));
      rows += actionRow({
        title: "Aggregate entries → native DAO deposits", next: true, btnId: "btn-aggregate", disabled: busy,
        btnLabel: `Aggregate (TX-05)`, sub: `${pending} entries in batches of ≤ ${batch} · membership proofs verified against frozen shard roots`,
      });
    }
    if (st === "ENTROPY") {
      rows += actionRow({
        title: "Finalise entropy", next: true, btnId: "btn-entropy", disabled: busy,
        btnLabel: "Finalise (TX-08/09)",
        sub: "seed = f(round, universe roots, tickets, participant reveals, future block hashes)",
        extra: `<div class="bash-hashes">simulated blocks: ${blockHashes.map((h) => trunc(h, 6)).join(" · ")}
          <button class="btn mini ghost" id="btn-reroll">reroll</button></div>`,
      });
    }
    if (st === "DRAW") {
      rows += actionRow({
        title: "Run the positional draw", next: true, btnId: "btn-draw", disabled: busy || revealCount > 0,
        btnLabel: "Draw", sub: `rejection sampling over ${fmtSh(engine.totalTickets)} tickets · distinct positions`,
      });
    }
    if (st === "DAO_WITHDRAWING") {
      const withdrawn = engine.compTotal > 0n;
      rows += actionRow({
        title: "DAO withdrawal — phase 1 + 2", next: !withdrawn, done: withdrawn, btnId: "btn-dao", disabled: busy || withdrawn,
        btnLabel: "Withdraw (TX-06/07)", disabled2: null,
        sub: `per deposit: same-index withdrawing cell, then realised capacity → settlement funding`,
      });
      rows += actionRow({
        title: "Settle — batched direct payouts", next: withdrawn, done: engine.stage === "COMPLETE", btnId: "btn-settle",
        disabled: busy || !withdrawn, btnLabel: "Settle (TX-10/11)",
        sub: "principal + prize + occupancy per participant, ascending lock-hash cursor",
      });
    }
    if (st === "COMPLETE") {
      rows += `<div class="locked-note">Round complete — every shannon accounted for. Export the verifier bundle and check it independently.</div>`;
    }
    body.innerHTML = rows;
  }

  // ------------------------------------------------------------------
  // shards
  // ------------------------------------------------------------------
  function renderShards() {
    const el = $("shards-body");
    if (!engine) { el.innerHTML = `<div class="empty">shard cells appear when the round is created</div>`; return; }
    el.innerHTML = engine.shardData.map((sd, i) => {
      const head = engine.shardHeads[i];
      return `
      <div class="shard-box">
        <div class="shard-head"><span class="shard-title">shard[${i}]</span><span class="chip ${sd.state === "OPEN" ? "open" : "frozen"}">${sd.state}</span></div>
        <dl>
          <dt>entries</dt><dd>${sd.entryCount}</dd>
          <dt>tickets</dt><dd>${fmtSh(sd.ticketCount)}</dd>
          <dt>principal</dt><dd title="${fmtSh(sd.principalTotal)} sh">${fmtCkb(sd.principalTotal)} CKB</dd>
          <dt>MMR root</dt><dd title="${sd.root}">${trunc(sd.root)}</dd>
          <dt>peaks</dt><dd>${head.peaks.length}</dd>
        </dl>
      </div>`;
    }).join("");
  }

  // ------------------------------------------------------------------
  // entries / participants
  // ------------------------------------------------------------------
  function renderEntries() {
    const el = $("entries-body");
    if (!engine || engine.participants.size === 0) { el.innerHTML = `<div class="empty">participants join while the round is OPEN</div>`; return; }
    const canTrade = engine.stage === "OPEN" && !busy;
    // global position space = shard-major prefix over frozen shard counts
    const prefix = [];
    let pAcc = 0n;
    for (const sd of engine.shardData) { prefix.push(pAcc); pAcc += BigInt(sd.ticketCount); }
    const rows = [...engine.participants.values()].map((p) => {
      const rec = p.entries[0];
      let status, range = "—", principal = "—";
      if (p.refunded) status = `<span class="chip red">REFUNDED</span>`;
      else if (!rec) status = `<span class="chip">WAITING</span>`;
      else {
        const e = rec.entry;
        const g = prefix[e.shardId] ?? 0n;
        range = `<span title="shard ${e.shardId} local [${e.positionBase}, ${BigInt(e.positionBase) + e.ticketCount})">[${g + e.positionBase}, ${g + BigInt(e.positionBase) + e.ticketCount})</span>`;
        principal = `<span title="${fmtSh(e.principal)} sh">${fmtCkb(e.principal)}</span>`;
        status = rec.aggregated ? `<span class="chip green">AGGREGATED</span>` : `<span class="chip open">ENTERED</span>`;
      }
      const prize = p.prize > 0n ? `<td class="num" style="color:var(--amber)" title="${fmtSh(p.prize)} sh">+${fmtCkb(p.prize)}</td>` : `<td class="num">—</td>`;
      const actions = [];
      if (canTrade && !rec && !p.refunded) actions.push(`<button class="btn mini accent" data-act="enter" data-name="${esc(p.name)}">buy tickets</button>`);
      if (canTrade && rec && !p.refunded) actions.push(`<button class="btn mini ghost" data-act="refund" data-name="${esc(p.name)}" title="refund pays only to this participant's committed lock">refund</button>`);
      const paid = p.paid > 0n ? `<td class="num" style="color:var(--green)" title="${fmtSh(p.paid)} sh">${fmtCkb(p.paid)}</td>` : `<td class="num">—</td>`;
      return `<tr>
        <td>${esc(p.name)}<div class="pos-note">${trunc([...engine.participants.keys()].find((k) => engine.participants.get(k) === p) || "", 6)}</div></td>
        <td class="num">${p.tickets}</td>
        <td class="pos-note">${range}</td>
        <td class="num">${principal}</td>
        <td>${status}</td>
        ${prize}${paid}
        <td>${actions.join(" ")}</td>
      </tr>`;
    }).join("");
    el.innerHTML = `<div class="scroll-x"><table>
      <thead><tr><th>participant</th><th class="num">tickets</th><th>positions</th><th class="num">principal</th><th>status</th><th class="num">prize</th><th class="num">paid back</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>
      <p class="hint" style="margin-top:8px">Entry capacity = principal + 205 shannons of structural padding; the padding rides through the DAO earning nothing and comes back at settlement.</p>`;
  }

  // ------------------------------------------------------------------
  // entropy + draw
  // ------------------------------------------------------------------
  function renderEntropy() {
    const el = $("entropy-body");
    if (!engine) { el.innerHTML = `<div class="empty">entropy is finalised after aggregation</div>`; return; }
    if (!engine.seedInputs) { el.innerHTML = `<div class="empty">waiting for aggregation to complete</div>`; return; }
    const si = engine.seedInputs;
    el.innerHTML = `
      <dl class="kv">
        <dt>round id</dt><dd>${trunc(si.roundId, 10)}</dd>
        <dt>universe roots</dt><dd>${si.entryUniverseRoot.map((r) => trunc(r, 6)).join("<br>")}</dd>
        <dt>total tickets</dt><dd>${fmtSh(si.totalTickets)}</dd>
        <dt>participant entropy</dt><dd title="${si.participantEntropyRoot}">${trunc(si.participantEntropyRoot, 10)}</dd>
        <dt>chain entropy</dt><dd title="${si.chainEntropyRoot}">${trunc(si.chainEntropyRoot, 10)}</dd>
        <dt>future blocks</dt><dd>${si.futureBlocks.map((h) => trunc(h, 6)).join("<br>")}</dd>
      </dl>
      ${engine.seed ? `<div class="seed-line">draw seed ${DaowowCore.hex(engine.seed)}</div>` : ""}`;
    if (engine.winners.length) {
      const medals = ["🥇", "🥈", "🥉", "🏅", "🏅", "🏅"];
      const shown = engine.winners.slice(0, revealCount);
      el.innerHTML += `<div class="winners">` + shown.map((w) => `
        <div class="winner ${w.prizeIndex === 0 ? "jackpot" : ""}">
          <span class="w-medal">${medals[w.prizeIndex] || "🏅"}</span>
          <span class="w-prize">#${w.prizeIndex + 1}</span>
          <span class="w-name">${w.name === "?" ? '<span style="color:var(--muted)">unowned ticket</span>' : esc(w.name)}</span>
          <span class="w-pos">ticket ${fmtSh(w.position)}<br>entry ticket #${w.ticketInEntry}</span>
        </div>`).join("") + (revealCount < engine.winners.length ? `<div class="pos-note">revealing…</div>` : "") + `</div>`;
    }
  }

  // ------------------------------------------------------------------
  // DAO custody
  // ------------------------------------------------------------------
  function phase2Compensation(batchId) {
    const tx = engine.txs.find((t) => t.kind === "dao-phase2" && t.name.endsWith(String(batchId)));
    return tx ? BigInt(tx.detail.compensation) : null;
  }
  function depositStatus(d) {
    const dep = engine.cells.get(d.cellId);
    const wd = engine.cells.get("withdrawing-" + d.batchId);
    if (wd && wd.spent) return `<span class="chip green">REALIZED</span>`;
    if (dep && dep.spent) return `<span class="chip amber">WITHDRAWING</span>`;
    return `<span class="chip open">DEPOSITED</span>`;
  }

  function renderDao() {
    const el = $("dao-body");
    if (!engine || engine.deposits.length === 0) { el.innerHTML = `<div class="empty">aggregation locks entry principal into real Nervos DAO deposit semantics (phase 1 / phase 2)</div>`; return; }
    const rows = engine.deposits.map((d) => {
      const comp = phase2Compensation(d.batchId);
      return `<tr>
        <td class="num">${d.batchId}</td>
        <td class="num">${d.entries.length}</td>
        <td class="num" title="${fmtSh(d.principal)} sh">${fmtCkb(d.principal)}</td>
        <td class="num" title="padding carried from entry cells, earns nothing">${fmtCkb(d.pad)}</td>
        <td class="num" title="${fmtSh(d.capacity)} sh">${fmtCkb(d.capacity)}</td>
        <td class="num">${d.epoch}</td>
        <td class="num" style="color:var(--amber)" title="${comp !== null ? fmtSh(comp) + " sh" : ""}">${comp !== null ? fmtCkb(comp) : "—"}</td>
        <td>${depositStatus(d)}</td>
      </tr>`;
    }).join("");
    el.innerHTML = `
      <p class="hint">Simulated DAO yield: <strong>${engine.yieldPercent}% of principal per term</strong> (≈2 lock periods). Only principal earns — carried padding is returned, never counted as yield.</p>
      <div class="scroll-x"><table>
        <thead><tr><th class="num">batch</th><th class="num">entries</th><th class="num">principal</th><th class="num">padding</th><th class="num">capacity</th><th class="num">epoch</th><th class="num">compensation</th><th>status</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`;
  }

  // ------------------------------------------------------------------
  // settlement
  // ------------------------------------------------------------------
  function renderSettle() {
    const el = $("settle-body");
    if (!engine || !engine.conservation) {
      el.innerHTML = `<div class="empty">after DAO withdrawal, realised capacity settles as direct payouts — conservation is checked to the last shannon</div>`;
      return;
    }
    const c = engine.conservation;
    const chip = (cls, lab, val, title) => `<div class="cons-chip ${cls}" title="${title}"><span class="c-val">${fmtCkb(val)}</span><span class="c-lab">${lab}</span></div>`;
    const cons = `
      <div class="conservation">
        ${chip("c-realized", "realized", c.realized, `${fmtSh(c.realized)} shannon(s)`)}<span class="cons-op">=</span>
        ${chip("", "principal", c.principal, `${fmtSh(c.principal)} sh`)}<span class="cons-op">+</span>
        ${chip("c-prizes", "prizes", c.prizes, `${fmtSh(c.prizes)} sh`)}<span class="cons-op">+</span>
        ${chip("", "occupancy", c.occupiedReserve, `${fmtSh(c.occupiedReserve)} sh`)}<span class="cons-op">+</span>
        ${chip("", "keeper fee", c.keeperFee, `${fmtSh(c.keeperFee)} sh`)}<span class="cons-op">+</span>
        ${chip("", "tx fees", c.txFees, `${fmtSh(c.txFees)} sh`)}<span class="cons-op">+</span>
        ${chip("c-residual", "residual", c.residual, `${fmtSh(c.residual)} sh`)}
      </div>
      <div class="cons-eq">${esc(c.equation)} — exact in shannons ✓<br>
        residual ${fmtSh(c.residual)} sh = carried padding ${fmtSh(engine.carriedPadding)} − payout occupancy ${fmtSh(c.occupiedReserve)} + prize dust ${fmtSh(engine.prizeDust)}</div>`;

    const sched = prizeSchedule(engine.totalTickets);
    const schedRows = engine.prizeAllocations.map((a) => {
      const w = engine.winners.filter((x) => x.prizeIndex === a.index);
      const meta = sched[a.index] || {};
      return `<tr>
        <td class="num">#${a.index + 1}</td><td>${esc(meta.name || "")}</td><td class="num">${a.weight}</td>
        <td class="num" style="color:var(--amber)" title="${fmtSh(a.amount)} sh">${fmtCkb(a.amount)}</td>
        <td>${w.length ? w.map((x) => esc(x.name) + ` <span class="pos-note">@${x.position}</span>`).join(", ") : "—"}</td>
      </tr>`;
    }).join("");

    const payoutRows = engine.payouts.map((p, i) => `<tr>
        <td class="num">${i + 1}</td>
        <td>${esc(p.name)}<div class="pos-note">${trunc(p.lockHash, 6)}</div></td>
        <td class="num" style="color:var(--green)" title="${fmtSh(p.principal)} sh">${fmtCkb(p.principal)}</td>
        <td class="num" style="color:var(--amber)" title="${fmtSh(p.prize)} sh">${p.prize > 0n ? fmtCkb(p.prize) : "—"}</td>
        <td class="num" title="${fmtSh(p.capacity)} sh — principal + prize + occupied capacity of the payout cell">${fmtCkb(p.capacity)}</td>
      </tr>`).join("");

    el.innerHTML = `
      ${cons}
      <h3>Prize schedule ${engine.prizeDust > 0n ? `<span class="hint-inline">dust ${fmtSh(engine.prizeDust)} sh → residual</span>` : `<span class="hint-inline">no rounding dust</span>`}</h3>
      <div class="scroll-x"><table>
        <thead><tr><th class="num">prize</th><th>tier</th><th class="num">weight</th><th class="num">amount</th><th>winner</th></tr></thead>
        <tbody>${schedRows}</tbody></table></div>
      <h3>Direct payouts (lock-hash cursor order)</h3>
      <div class="scroll-x"><table>
        <thead><tr><th class="num">#</th><th>participant</th><th class="num">principal</th><th class="num">prize</th><th class="num">capacity</th></tr></thead>
        <tbody>${payoutRows}</tbody></table></div>`;
  }

  // ------------------------------------------------------------------
  // ledger drawer
  // ------------------------------------------------------------------
  function jsonSafe(v) { return JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 1); }

  function renderLedger() {
    const n = engine ? engine.txs.length : 0;
    const cyc = engine ? engine.txs.reduce((a, t) => a + (t.cycles || 0n), 0n) : 0n;
    $("ledger-stats").textContent = `${n} txs · Σ ${fmtCycles(cyc)} cycles`;
    if (!engine || n === 0) { $("ledger-body").innerHTML = `<div class="empty">no transactions yet</div>`; return; }
    $("ledger-body").innerHTML = engine.txs.map((t) => {
      const ins = (t.inputs || []).map((i) => `<div>${esc(i.who)} <span class="pos-note">${fmtCkb(i.capacity)} CKB</span></div>`).join("") || "<div>—</div>";
      const outs = (t.outputs || []).map((o) => `<div>${esc(o.who)} <span class="pos-note">${fmtCkb(o.capacity)} CKB</span></div>`).join("") || "<div>—</div>";
      const moves = engine.ledger.filter((m) => m.tx === t.id).map((m) => `<div>${esc(m.from)} → ${esc(m.to)} <span class="pos-note">${fmtSh(m.amount)} sh · ${esc(m.what)}</span></div>`).join("") || "<div>—</div>";
      return `<details class="tx-item">
        <summary><span class="tx-id">${t.id}</span><span class="tx-name">${esc(t.name)}</span><span class="tx-cycles">${fmtCycles(t.cycles)} cycles</span></summary>
        <div class="tx-detail">
          <dl class="kv"><dt>inputs</dt><dd>${ins}</dd><dt>outputs</dt><dd>${outs}</dd><dt>capacity moves</dt><dd>${moves}</dd></dl>
          ${t.detail ? `<dl class="kv"><dt>detail</dt><dd><pre style="margin:0;white-space:pre-wrap;font:10.5px var(--mono);color:var(--muted)">${esc(jsonSafe(t.detail))}</pre></dd></dl>` : ""}
        </div>
      </details>`;
    }).join("");
  }

  // ------------------------------------------------------------------
  // master render
  // ------------------------------------------------------------------
  function render() {
    renderStepper();
    renderConfig();
    renderActions();
    renderShards();
    renderEntries();
    renderEntropy();
    renderDao();
    renderSettle();
    renderLedger();
    $("btn-export").disabled = !engine;
    $("stat-round").textContent = engine ? `round ${trunc(engine.roundIdHex || "")}` : "";
    if (engine) {
      // roundId is a Uint8Array in the engine; expose hex lazily
      if (!engine.roundIdHex) engine.roundIdHex = DaowowCore.hex(engine.roundId);
      $("stat-round").textContent = `round ${trunc(engine.roundIdHex, 10)}`;
    }
  }

  // ------------------------------------------------------------------
  // engine lifecycle
  // ------------------------------------------------------------------
  function createRound() {
    const cfg = {
      name: $("cfg-name").value.trim() || "round",
      ticketPriceCkb: Number($("cfg-price").value),
      shards: Math.max(1, Math.min(32, Math.floor(Number($("cfg-shards").value) || 1))),
      minTickets: Math.max(1, Math.floor(Number($("cfg-mintickets").value) || 1)),
      keeperFeeCkb: Math.max(0, Number($("cfg-keeper").value) || 0),
      yieldPercent: Number($("cfg-yield").value) || 2,
    };
    try {
      engine = new DaowowEngine.Engine(cfg, { onTx: () => {} });
      engine.createRound();
      for (const p of draft) engine.addParticipant(p.name.trim(), p.tickets, p.secret);
    } catch (err) {
      engine = null;
      toast(esc(err.message), "error", err.code ?? "?");
      render();
      return;
    }
    revealCount = 0;
    if (revealTimer) clearTimeout(revealTimer);
    toast(`Round <strong>${esc(cfg.name)}</strong> created — ${cfg.shards} shard(s), ${draft.length} participant(s) registered. Entry window is OPEN.`);
    render();
  }

  function enterAll() {
    const waiting = [...engine.participants.values()].filter((p) => p.entries.length === 0 && !p.refunded);
    let ok = 0;
    for (const p of waiting) {
      try { engine.enter(p.name); ok++; } catch (err) { toast(esc(err.message), "error", err.code ?? "?"); break; }
    }
    if (ok) toast(`${ok} entr${ok === 1 ? "y" : "ies"} accepted across ${engine.shards} shard(s)`);
    render();
  }

  function startReveal() {
    if (revealTimer) clearTimeout(revealTimer);
    const tick = () => {
      if (!engine || revealCount >= engine.winners.length) return;
      revealCount += 1;
      renderEntropy();
      if (revealCount === engine.winners.length) toast("Draw complete — winners are reproducible from public chain data", "success");
      else revealTimer = setTimeout(tick, 480);
    };
    revealTimer = setTimeout(tick, 250);
  }

  // ------------------------------------------------------------------
  // auto-run
  // ------------------------------------------------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function autoRun() {
    if (busy || !engine) return;
    busy = true;
    render();
    try {
      if (engine.stage === "OPEN") {
        enterAll(); await sleep(250);
        attempt(() => engine.freeze(), "Shards frozen — entry window closed"); await sleep(250);
      }
      if (engine.stage === "FROZEN") {
        const batch = Math.max(1, Math.floor(Number($("cfg-batch").value) || 3));
        const txs = engine.aggregate(batch);
        toast(`Aggregated ${engine.entries.filter((e) => e.aggregated).length} entries into ${txs.length} native DAO deposit(s)`); render(); await sleep(350);
      }
      if (engine.stage === "ENTROPY") {
        engine.finalizeEntropy(blockHashes.map((h) => DaowowCore.unhex(h)));
        toast("Entropy finalised — seed derived from public inputs"); render(); await sleep(250);
      }
      if (engine.stage === "DRAW" && revealCount === 0) {
        engine.draw();
        busy = false; render(); startReveal();
        while (revealCount < engine.winners.length) await sleep(120);
        await sleep(600);
        busy = true;
      }
      if (engine.stage === "DAO_WITHDRAWING" && engine.compTotal === 0n) {
        engine.daoWithdraw();
        toast(`DAO realised ${fmtCkb(engine.compTotal)} CKB of compensation`); render(); await sleep(350);
      }
      if (engine.stage === "DAO_WITHDRAWING" && engine.compTotal > 0n) {
        engine.settle();
        toast("Settlement complete — conservation holds to the last shannon ✓");
      }
    } catch (err) {
      toast(esc(err.message), "error", err.code ?? "?", "mirrors the on-chain script rejection");
    }
    busy = false;
    render();
  }

  // ------------------------------------------------------------------
  // export
  // ------------------------------------------------------------------
  function exportBundle() {
    if (!engine) return;
    const blob = new Blob([JSON.stringify(engine.export(), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `daowow-verifier-bundle-${(engine.roundIdHex || "round").slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast("Verifier bundle downloaded — an independent verifier can reproduce seed and winners from it");
  }

  // ------------------------------------------------------------------
  // adversarial panel
  // ------------------------------------------------------------------
  function advRun(kind) {
    if (!engine) { toast("Create a round first", "error"); return; }
    const people = [...engine.participants.values()];
    const name = people.find((p) => p.entries.length > 0)?.name || people[0]?.name || "alice";
    const fns = {
      forge: () => engine.attemptForgeRoot(name),
      double: () => engine.attemptDoublePayout(name),
      operator: () => engine.attemptPayoutToOperator(),
      substitute: () => engine.attemptPhase1Substitution(),
    };
    const labels = { forge: "forge shard root", double: "double payout", operator: "payout to operator", substitute: "phase-1 lock substitution" };
    try {
      fns[kind]();
      advLines.unshift(`<div class="adv-line ok">⚠ ${labels[kind]} unexpectedly SUCCEEDED — this would be a protocol break</div>`);
    } catch (err) {
      advLines.unshift(`<div class="adv-line">✗ ${labels[kind]} rejected · error ${err.code} · ${esc(err.message)}</div>`);
      toast(esc(err.message), "error", err.code, `adversarial “${labels[kind]}” — rejected exactly as the on-chain script would`);
    }
    advLines = advLines.slice(0, 12);
    $("adv-log").innerHTML = advLines.join("");
  }

  // ------------------------------------------------------------------
  // wiring
  // ------------------------------------------------------------------
  $("btn-create").addEventListener("click", createRound);
  $("btn-add-participant").addEventListener("click", () => {
    draft.push({ name: "participant-" + (draft.length + 1), tickets: 3, secret: "" });
    render();
  });
  $("btn-demo-participants").addEventListener("click", () => {
    draft = ["alice", "bob", "carol", "dave", "erin", "frank", "grace", "heidi"].map((n, i) => ({ name: n, tickets: 3 + (i % 4), secret: "secret-" + n }));
    render();
  });
  $("draft-participants").addEventListener("input", readDraft);

  $("btn-autorun").addEventListener("click", autoRun);
  $("btn-export").addEventListener("click", exportBundle);

  document.addEventListener("click", (ev) => {
    const t = ev.target.closest("button");
    if (!t || busy) { if (t && busy && t.id !== "ledger-bar") toast("engine busy — auto-run in progress", "error"); return; }
    switch (t.id) {
      case "btn-reroll": rerollHashes(); renderActions(); break;
      case "btn-freeze": attempt(() => engine.freeze(), "Shards frozen — entry window closed, accumulator roots immutable"); break;
      case "btn-enter-all": enterAll(); break;
      case "btn-aggregate": {
        const batch = Math.max(1, Math.floor(Number($("cfg-batch").value) || 3));
        attempt(() => {
          const txs = engine.aggregate(batch);
          return txs.length;
        }, `Entries aggregated into native DAO deposits (batches of ≤ ${batch})`);
        break;
      }
      case "btn-entropy": attempt(() => engine.finalizeEntropy(blockHashes.map((h) => DaowowCore.unhex(h))), "Entropy finalised — seed derivation inputs are now public"); break;
      case "btn-draw": attempt(() => engine.draw()); startReveal(); break;
      case "btn-dao": attempt(() => engine.daoWithdraw(), "DAO phases 1+2 complete — realised compensation moved to settlement funding"); break;
      case "btn-settle": attempt(() => engine.settle(), "Settlement complete — conservation holds to the last shannon ✓"); break;
      default:
        if (t.dataset.act === "enter") attempt(() => engine.enter(t.dataset.name));
        if (t.dataset.act === "refund") attempt(() => engine.refund(t.dataset.name), "Refund paid to the participant's committed lock");
    }
  });

  $("adv-forge").addEventListener("click", () => advRun("forge"));
  $("adv-double").addEventListener("click", () => advRun("double"));
  $("adv-operator").addEventListener("click", () => advRun("operator"));
  $("adv-substitute").addEventListener("click", () => advRun("substitute"));

  $("ledger-bar").addEventListener("click", () => $("ledger").classList.toggle("open"));

  // initial demo draft so the page is usable immediately
  draft = ["alice", "bob", "carol", "dave", "erin", "frank", "grace", "heidi"].map((n, i) => ({ name: n, tickets: 3 + (i % 4), secret: "secret-" + n }));
  render();
})();
