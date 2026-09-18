"use strict";
// Provenance and agreement checks for the only third-party code in this tree.
//
// The bundle is committed so the served page needs no build step, CDN or
// node_modules. That convenience is only safe if two things stay true: the
// artifact is the one we built, and its crypto is the crypto the contracts
// use. Both are asserted here rather than assumed.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");

const VENDOR = path.join(__dirname, "..", "vendor");
const ARTIFACT = path.join(VENDOR, "ccc-joyid.min.mjs");
const LOCK = path.join(VENDOR, "ccc-joyid.lock.json");
const VECTORS = path.join(
  __dirname, "..", "..", "..", "tests", "vectors", "daowow_core_vectors.json");

test("the vendored artifact matches its lock file", () => {
  const lock = JSON.parse(fs.readFileSync(LOCK, "utf8"));
  const got = crypto.createHash("sha256")
    .update(fs.readFileSync(ARTIFACT)).digest("hex");
  // A silent swap of the bundle fails here rather than in production.
  assert.strictEqual(got, lock.artifactSha256);
});

test("the vendored crypto agrees with the Rust oracle", async () => {
  // Positive control: a value impossible to produce by accident. If the
  // vendored bundle does not hash the way the contracts hash, everything
  // built on top of it is wrong, and this is the cheapest place to find out.
  const vectors = JSON.parse(fs.readFileSync(VECTORS, "utf8"));
  const { ccc } = await import("../vendor/ccc-joyid.min.mjs");
  const got = ccc
    .hashCkb(ccc.bytesFrom(vectors.domain_hash.input, "utf8"))
    .replace(/^0x/, "");
  assert.strictEqual(got, vectors.domain_hash.output);
});
