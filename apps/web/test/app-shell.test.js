"use strict";
// The served app, checked as text: its security policy, its structure, and
// the things it must never contain. A page trusted with a wallet earns that
// by what is provably absent from it.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const WEB = path.join(__dirname, "..");
const ROOT = path.join(WEB, "..", "..");
const read = (rel) => fs.readFileSync(path.join(WEB, rel), "utf8");
const walk = (rel) => fs.readdirSync(path.join(WEB, rel), { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(rel, e.name)) : [path.join(rel, e.name)]);
const html = read("dapp/index.html");
const live = (files) => files;
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the shell carries the exact content security policy", () => {
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1]
    .split(";").map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean);
  assert.deepStrictEqual(csp, [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self' https://testnet.ckb.dev",
    "form-action 'none'",
    "base-uri 'none'",
  ]);
});

test("no served file names the private node", () => {
  for (const f of live(walk("dapp"))) assert.doesNotMatch(read(f), /192\.168\.|localhost|127\.0\.0\.1/, f);
});

test("no file under dapp/ writes HTML from a string", () => {
  for (const f of walk("dapp").filter((x) => x.endsWith(".js"))) {
    assert.doesNotMatch(code(read(f)), /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(/, f);
  }
});

test("the shell has the four tabs in order and one section per tab", () => {
  const tabs = [...html.matchAll(/<a[^>]*class="tab"[^>]*href="(#\/[a-z]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(tabs, ["#/home", "#/rounds", "#/tickets", "#/how"]);
  for (const id of ["view-home", "view-rounds", "view-tickets", "view-how", "view-panel"]) {
    assert.strictEqual((html.match(new RegExp(`<section[^>]*id="${id}"`, "g")) ?? []).length, 1, id);
  }
  for (const label of ["Home", "Rounds", "My tickets", "How it works"]) {
    assert.match(html, new RegExp(`>\\s*${label}\\s*<`), label);
  }
});

test("no inline script, style attribute or event handler attribute in the shell", () => {
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/);
  assert.doesNotMatch(html, /<style/);
  assert.doesNotMatch(html, /\sstyle=|\son[a-z]+=/);
});

test("every script and stylesheet is loaded from this origin by a relative path", () => {
  const refs = [...html.matchAll(/<(?:script|link)[^>]*(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length > 10);
  for (const ref of refs) {
    if (ref.startsWith("data:")) continue;
    assert.doesNotMatch(ref, /^(https?:)?\/\//, ref);
    assert.ok(fs.existsSync(path.join(WEB, "dapp", ref)), `${ref} must exist`);
  }
});

test("the page shows no node address and no raw chain clock", () => {
  assert.doesNotMatch(html, /id="rpc"|id="epoch"|tip epoch/);
});

test("the public manifest is the dev deployment with only the node address changed", () => {
  const pub = JSON.parse(read("dapp/manifest.json"));
  const dev = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", "dev-testnet-manifest.json"), "utf8"));
  assert.strictEqual(pub.rpcUrl, "https://testnet.ckb.dev");
  assert.deepStrictEqual({ ...pub, rpcUrl: null }, { ...dev, rpcUrl: null });
});

test("nothing under dapp/ reads ?manifest= or ?round= any more", () => {
  for (const f of live(walk("dapp")).filter((x) => x.endsWith(".js"))) {
    assert.doesNotMatch(code(read(f)), /get\("manifest"\)|get\("round"\)|location\.search/, f);
  }
});

test("the app loads its manifest from its own folder", () => {
  assert.match(code(read("dapp/app/main.js")), /fetch\("\.\/manifest\.json"/);
});

test("the wallet's signer never leaves the wallet module", () => {
  for (const f of walk("dapp").filter((x) => x.endsWith(".js"))) {
    assert.doesNotMatch(code(read(f)), /CkbSigner|signTransaction|sendTransaction|window\.\w*[sS]ession\s*=/, f);
  }
});

test("a wallet connect failure is shown on the page, not only logged", () => {
  const main = code(read("dapp/app/main.js"));
  assert.match(main, /errors\.wallet\(/);
});

// --- the ball machine --------------------------------------------------------
const stageSource = () => code(read("dapp/app/draw/stage.js"));

test("the stage imports Three.js only from the vendored file", () => {
  const src = stageSource();
  const imports = [...src.matchAll(/\bfrom\s+"([^"]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(imports, ["../../../vendor/three.module.min.js"]);
  assert.doesNotMatch(src, /https?:\/\//);
  assert.doesNotMatch(src, /\bimport\s*\(/);
});

test("the stage takes its randomness from the draw's own seed", () => {
  const src = stageSource();
  assert.match(src, /seededRandom\(script\.seed\)/);
  assert.doesNotMatch(src, /Math\.random|crypto\.getRandomValues|Date\.now\(\)\s*%/);
});

test("the stage exposes play, skip, replay and dispose", () => {
  assert.match(stageSource(), /return\s*\{\s*play,\s*skip,\s*replay,\s*dispose\s*\}/);
});

test("the stage frees what it allocates and caps the pixel ratio", () => {
  const src = stageSource();
  assert.match(src, /renderer\.dispose\(\)/);
  assert.match(src, /cancelAnimationFrame/);
  assert.match(src, /setPixelRatio\(Math\.min\(window\.devicePixelRatio[^)]*, 2\)\)/);
});

test("the draw screen falls back to the list for reduced motion and for a failed stage", () => {
  const src = code(read("dapp/app/views/draw.js"));
  assert.match(src, /prefers-reduced-motion: reduce/);
  assert.match(src, /catch\s*\{[\s\S]*?asList\(/);
});

test("only the entry and refund views can reach the signing operations", () => {
  const views = walk("dapp/app").filter((f) => f.endsWith(".js"));
  const allowed = ["dapp/app/views/enter.js", "dapp/app/views/tickets.js", "dapp/app/main.js"];
  for (const f of views) {
    const touches = /signEntry|\.broadcast\(|signing\(/.test(code(read(f)));
    assert.strictEqual(touches, allowed.includes(f), f);
  }
  for (const f of walk("dapp/model")) {
    assert.doesNotMatch(code(read(f)), /signEntry|\.broadcast\(/, f);
  }
});

test("the three retired pages are script-free redirects into the app", () => {
  for (const [page, to] of [["entry.html", "./#/rounds"], ["refund.html", "./#/tickets"], ["how-it-works.html", "./#/how"]]) {
    const old = read(`dapp/${page}`);
    assert.ok(old.includes(`<meta http-equiv="refresh" content="0; url=${to}">`), page);
    assert.doesNotMatch(old, /<script|<link|<style|\son[a-z]+=/, page);
    assert.match(old, /http-equiv="Content-Security-Policy" content="default-src 'none'"/, page);
  }
});
