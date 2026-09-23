"use strict";
// D7's two honesty constraints, encoded as tests rather than left as good
// intentions. Explainer pages drift toward marketing, and prose has no
// compiler.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const PAGE = fs.readFileSync(
  path.join(__dirname, "..", "dapp", "how-it-works.html"), "utf8");
const text = PAGE.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("it leads with the fact everything else depends on", () => {
  // A visitor who misses this reads the page as a conventional lottery where
  // losers fund winners, which is the opposite of the design.
  const lede = text.slice(0, 900);
  assert.match(lede, /Nervos DAO yield/i);
  assert.match(lede, /principal back/i);
  assert.match(lede, /Nobody's stake pays anybody else's prize/i);
});

test("the draw section states its actual mechanism", () => {
  assert.match(text, /four separate blocks/i);
  for (const offset of [64, 128, 192, 256]) {
    assert.match(text, new RegExp(`\\b${offset}\\b`), `block offset ${offset}`);
  }
  assert.match(text, /sealed/i, "the entry list is sealed before entropy exists");
});

test("the draw section does NOT overclaim", () => {
  // The limitation must be stated, not implied by omission.
  assert.match(text, /not a verifiable random function/i);
  assert.match(text, /not a randomness beacon|and not a randomness beacon/i);
  assert.match(text, /grind/i, "miner grinding must be named, not hinted at");
  // And it must not claim what it cannot deliver.
  assert.doesNotMatch(text, /provably fair/i);
  assert.doesNotMatch(text, /impossible to manipulate|cannot be manipulated/i);
  assert.doesNotMatch(text, /truly random/i);
});

test("it says what works today and what does not", () => {
  const section = text.slice(text.indexOf("What works today"));
  assert.ok(section.length > 200, "the section must exist");
  assert.match(section, /not yet available in this interface/i);
  for (const unbuilt of ["Transferring", "Redeeming", "Retiring", "animated draw"]) {
    assert.match(section, new RegExp(unbuilt, "i"), `${unbuilt} must be listed as unbuilt`);
  }
});

test("the capacity overhead is described as locked, not spent", () => {
  assert.match(text, /222 CKB/);
  assert.match(text, /locked, not spent/i);
  assert.match(text, /returns to you/i);
});

test("it does not promise returns or call testnet funds valuable", () => {
  assert.match(text, /testnet/i);
  assert.match(text, /no monetary value|no real value/i);
  assert.doesNotMatch(text, /guaranteed (return|profit|yield)/i);
  assert.doesNotMatch(text, /risk[- ]free/i);
});
