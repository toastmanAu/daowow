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
const ARTIFACT = path.join(VENDOR, "ccc.min.mjs");
const LOCK = path.join(VENDOR, "ccc.lock.json");
const VECTORS = path.join(
  __dirname, "..", "..", "..", "tests", "vectors", "daowow_core_vectors.json");

test("the vendored artifact matches its lock file", () => {
  const lock = JSON.parse(fs.readFileSync(LOCK, "utf8"));
  const got = crypto.createHash("sha256")
    .update(fs.readFileSync(ARTIFACT)).digest("hex");
  // A silent swap of the bundle fails here rather than in production.
  assert.strictEqual(got, lock.artifactSha256);
});

// The bundle carries more than CCC: its own dependencies do the hashing and
// the curve maths. Those are pinned by an npm lock file, and the bundle's lock
// records WHICH npm lock it was built from, so neither can move alone.
const PINS = path.join(__dirname, "..", "..", "..", "tools", "vendor-ccc");

test("the bundle was built from the committed dependency lock", () => {
  const lock = JSON.parse(fs.readFileSync(LOCK, "utf8"));
  assert.strictEqual(lock.dependencyLock, "tools/vendor-ccc/package-lock.json");
  const got = crypto.createHash("sha256")
    .update(fs.readFileSync(path.join(PINS, "package-lock.json"))).digest("hex");
  assert.strictEqual(got, lock.dependencyLockSha256,
    "the dependency lock changed without a rebuild: run tools/build-vendor-ccc.sh");
});

test("every bundled dependency is pinned to an exact version and tarball hash", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PINS, "package.json"), "utf8"));
  const pins = JSON.parse(fs.readFileSync(path.join(PINS, "package-lock.json"), "utf8"));
  const exact = /^\d+\.\d+\.\d+$/;
  for (const [name, range] of Object.entries(
    { ...manifest.dependencies, ...manifest.devDependencies })) {
    assert.match(range, exact, `${name} must be an exact version, not a range`);
  }
  const entries = Object.entries(pins.packages).filter(([where]) => where !== "");
  assert.ok(entries.length > 0);
  for (const [where, entry] of entries) {
    assert.match(entry.integrity ?? "", /^sha512-/, `${where} has no tarball hash`);
    assert.ok((entry.resolved ?? "").startsWith("https://registry.npmjs.org/"),
      `${where} does not come from the npm registry`);
  }
  const lock = JSON.parse(fs.readFileSync(LOCK, "utf8"));
  assert.strictEqual(pins.packages["node_modules/esbuild"].version, lock.esbuild);
  for (const [name, version] of Object.entries(lock.packages)) {
    assert.strictEqual(pins.packages[`node_modules/${name}`].version, version);
  }
});

test("the vendored crypto agrees with the Rust oracle", async () => {
  // Positive control: a value impossible to produce by accident. If the
  // vendored bundle does not hash the way the contracts hash, everything
  // built on top of it is wrong, and this is the cheapest place to find out.
  const vectors = JSON.parse(fs.readFileSync(VECTORS, "utf8"));
  const { ccc } = await import("../vendor/ccc.min.mjs");
  const got = ccc
    .hashCkb(ccc.bytesFrom(vectors.domain_hash.input, "utf8"))
    .replace(/^0x/, "");
  assert.strictEqual(got, vectors.domain_hash.output);
});

// --- Three.js, for the draw animation ---------------------------------------
const THREE_ARTIFACT = path.join(VENDOR, "three.module.min.js");
const THREE_LOCK = path.join(VENDOR, "three.lock.json");

test("the vendored Three.js matches its lock file", () => {
  const lock = JSON.parse(fs.readFileSync(THREE_LOCK, "utf8"));
  const got = crypto.createHash("sha256").update(fs.readFileSync(THREE_ARTIFACT)).digest("hex");
  assert.strictEqual(got, lock.artifactSha256);
});

test("the Three.js lock pins 0.170.0 and its registry integrity", () => {
  const lock = JSON.parse(fs.readFileSync(THREE_LOCK, "utf8"));
  assert.deepStrictEqual(lock.packages, { three: "0.170.0" });
  assert.strictEqual(lock.tarballIntegrity,
    "sha512-FQK+LEpYc0fBD+J8g6oSEyyNzjp+Q7Ks1C568WWaoMRLW+TkNNWmenWeGgJjV105Gd+p/2ql1ZcjYvNiPZBhuQ==");
  assert.strictEqual(lock.source, "package/build/three.module.min.js");
});

test("the vendored Three.js is a single file with no imports of its own", () => {
  const src = fs.readFileSync(THREE_ARTIFACT, "utf8");
  assert.ok(src.length > 300000, "this should be the whole library");
  assert.doesNotMatch(src, /(^|[;\n])\s*import\s*[\w{*"']/);
  assert.doesNotMatch(src, /\bimport\s*\(/);
  assert.doesNotMatch(src, /\bfrom\s*["']\.{0,2}\//);
});

test("the vendored Three.js needs no eval, so the strict CSP can stay", () => {
  const src = fs.readFileSync(THREE_ARTIFACT, "utf8");
  assert.doesNotMatch(src, /\beval\s*\(|new Function\s*\(/);
});

test("the vendored Three.js reports the pinned revision", async () => {
  const THREE = await import("../vendor/three.module.min.js");
  assert.strictEqual(THREE.REVISION, "170");
});
