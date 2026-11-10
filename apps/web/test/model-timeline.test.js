"use strict";
// The "you are here" line on Home. It shows what the chain does, in order:
// the draw comes soon after entries close, and the savings term runs AFTER it.
const { test } = require("node:test");
const assert = require("node:assert");
const { buildTimeline } = require("../dapp/model/timeline.js");
const { PLAYER_STATE: S } = require("../dapp/model/round-state.js");

const tip = { height: 1100n, epoch: { number: 1005n, index: 0n, length: 1800n } };
const fixture = (state, over = {}) => ({
  snapshot: {
    config: { entryStart: 1001n, entryEnd: 1010n, daoTermPeriods: 1, ...over.config },
    seal: over.seal ?? null,
  },
  view: { state },
  tip,
});
const here = (steps) => steps.filter((s) => s.here).map((s) => s.key);
const BANNED = /\b(epochs?|shards?|cells?|ledgers?|freez\w*|frozen|genesis|aggregat\w*|commitments?|out ?points?|lock hash\w*|witness\w*)\b/i;

test("the draw comes before the savings term", () => {
  assert.deepStrictEqual(buildTimeline(fixture(S.OPEN)).steps.map((s) => s.key),
    ["opens", "closes", "draw", "term", "payout"]);
});

test("an upcoming round is 'here' at 'opens', with a time", () => {
  const t = buildTimeline(fixture(S.UPCOMING, { config: { entryStart: 1011n, entryEnd: 1020n } }));
  assert.deepStrictEqual(here(t.steps), ["opens"]);
  assert.strictEqual(t.steps[0].when, "in about 24 h");
});

test("an open round is 'here' at 'closes'", () => {
  const t = buildTimeline(fixture(S.OPEN));
  assert.deepStrictEqual(here(t.steps), ["closes"]);
  assert.strictEqual(t.steps[1].when, "in about 20 h");
  assert.strictEqual(t.steps[0].done, true);
  assert.strictEqual(t.steps[2].done, false);
});

test("after entries close and before the draw, 'here' is the draw step", () => {
  const unsealed = buildTimeline(fixture(S.WAITING));
  assert.deepStrictEqual(here(unsealed.steps), ["draw"]);
  assert.doesNotMatch(unsealed.steps[2].when, /\d/, "no time is promised before the draw is scheduled");
  const sealed = buildTimeline(fixture(S.WAITING, { seal: { inclusionHeight: 1000n } }));
  assert.strictEqual(sealed.steps[2].when, "in about 15 min");
});

test("a drawn round is 'here' at the savings term until payout exists", () => {
  const t = buildTimeline(fixture(S.DRAWN));
  assert.deepStrictEqual(here(t.steps), ["term"]);
  assert.deepStrictEqual(t.steps.map((s) => s.done), [true, true, true, false, false]);
});

test("exactly one step is 'here' in every state", () => {
  for (const state of Object.values(S)) {
    assert.strictEqual(here(buildTimeline(fixture(state)).steps).length, 1, state);
  }
});

test("a round that didn't go ahead is marked ended, so no payout is implied", () => {
  assert.strictEqual(buildTimeline(fixture(S.REFUNDS)).ended, true);
  assert.strictEqual(buildTimeline(fixture(S.FINISHED)).ended, true);
  assert.strictEqual(buildTimeline(fixture(S.OPEN)).ended, false);
  assert.strictEqual(buildTimeline(fixture(S.DRAWN)).ended, false);
});

test("the term length comes from the round, 180 four-hour periods each", () => {
  const term = (periods) =>
    buildTimeline(fixture(S.OPEN, { config: { daoTermPeriods: periods } })).steps[3].when;
  assert.strictEqual(term(1), "about 30 days");
  assert.strictEqual(term(2), "about 60 days");
});

test("timeline wording carries no banned word, and every time says 'about'", () => {
  for (const state of Object.values(S)) {
    for (const seal of [null, { inclusionHeight: 1000n }]) {
      for (const step of buildTimeline(fixture(state, { seal })).steps) {
        assert.doesNotMatch(`${step.label} ${step.when}`, BANNED);
        if (/\d/.test(step.when)) assert.match(step.when, /about/);
      }
    }
  }
});
