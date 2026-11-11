"use strict";
// What gets published. The site is a plain copy of a fixed list of files, and
// the list is the security boundary: nothing outside it reaches the internet.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..", "..");
const load = () => import(path.join(ROOT, "tools", "build-site.mjs"));

test("the site contains only allow-listed files", async () => {
  const { listSiteFiles } = await load();
  const files = listSiteFiles().map((f) => f.to);
  assert.ok(files.length > 40);
  for (const f of files) {
    assert.match(f, /^(core\.js$|chain\/[a-z-]+\.js$|vendor\/[a-z.-]+$|dapp\/|_headers$|_redirects$)/, f);
    assert.doesNotMatch(f, /\.md$|\.test\.js$|\.local\.json$|\.toml$|\.sh$|\.map$/, f);
    assert.doesNotMatch(f, /\.\./, f);
  }
  for (const needed of ["dapp/index.html", "dapp/manifest.json", "dapp/app/main.js", "core.js",
    "chain/wallet.js", "vendor/ccc-joyid.min.mjs", "vendor/three.module.min.js", "_headers", "_redirects"]) {
    assert.ok(files.includes(needed), `${needed} must be published`);
  }
});

test("no deployments file, test, tool, contract or key material is published", async () => {
  const { listSiteFiles } = await load();
  for (const { from } of listSiteFiles()) {
    const rel = path.relative(ROOT, from);
    assert.match(rel, /^apps\/web\/(core\.js|chain\/|vendor\/|dapp\/|site\/)/, rel);
    assert.doesNotMatch(rel, /deployments|\/test\/|^tools\/|contracts|\.env|\.pem|\.key$/, rel);
  }
});

test("the prototype simulator and the private manifest are not published", async () => {
  const { listSiteFiles } = await load();
  const files = listSiteFiles().map((f) => f.to);
  for (const f of ["app.js", "engine.js", "index.html", "entry.html", "dev-testnet-manifest.json", "vendor/README.md"]) {
    assert.ok(!files.includes(f), `${f} must not be published`);
  }
});

test("building copies the files unchanged and writes the root redirect", async () => {
  const { buildSite } = await load();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "daowow-site-"));
  try {
    const copied = buildSite(out);
    assert.ok(copied > 40);
    const same = (a, b) => assert.ok(fs.readFileSync(path.join(out, a)).equals(
      fs.readFileSync(path.join(ROOT, "apps", "web", b))), a);
    same("dapp/index.html", "dapp/index.html");
    same("vendor/three.module.min.js", "vendor/three.module.min.js");
    same("chain/wallet.js", "chain/wallet.js");
    assert.match(fs.readFileSync(path.join(out, "_redirects"), "utf8"), /^\/ \/dapp\/ 302$/m);
    assert.ok(!fs.existsSync(path.join(out, "vendor", "README.md")));
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("a file naming the private node stops the build", async () => {
  const { leaks } = await load();
  assert.deepStrictEqual(leaks("dapp/x.js", "fetch('http://192.168.68.134:8114')"), ["192.168."]);
  assert.deepStrictEqual(leaks("dapp/x.js", "http://localhost:8114"), ["localhost"]);
  assert.deepStrictEqual(leaks("dapp/x.js", "https://testnet.ckb.dev"), []);
  // The vendored wallet library mentions localhost in its own defaults.
  assert.deepStrictEqual(leaks("vendor/ccc-joyid.min.mjs", "http://localhost:8114"), []);
  assert.deepStrictEqual(leaks("vendor/ccc-joyid.min.mjs", "192.168.1.1"), ["192.168."]);
});

test("no published file mentions the LAN node", async () => {
  const { listSiteFiles, leaks } = await load();
  for (const { from, to } of listSiteFiles()) {
    assert.deepStrictEqual(leaks(to, fs.readFileSync(from, "utf8")), [], to);
  }
});

const headers = () => fs.readFileSync(path.join(ROOT, "apps", "web", "site", "_headers"), "utf8");
const directives = (csp) => csp.split(";").map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean);

test("the header policy is the page's policy plus a ban on framing", () => {
  const html = fs.readFileSync(path.join(ROOT, "apps", "web", "dapp", "index.html"), "utf8");
  const page = directives(html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1]);
  const header = directives(headers().match(/Content-Security-Policy: (.+)/)[1]);
  assert.deepStrictEqual(header, [...page, "frame-ancestors 'none'"]);
});

test("the headers forbid framing, sniffing and referrers, for every path", () => {
  const h = headers();
  assert.match(h, /^\/\*$/m);
  assert.match(h, /frame-ancestors 'none'/);
  assert.match(h, /X-Content-Type-Options: nosniff/);
  assert.match(h, /Referrer-Policy: no-referrer/);
  assert.match(h, /Permissions-Policy: camera=\(\), microphone=\(\), geolocation=\(\)/);
});

// A visitor must never run yesterday's scripts against today's page. The
// daowow.org zone stretched Pages' own max-age=0 to four hours for scripts,
// and a phone kept buying tickets with a build from before the per-wallet
// limit. no-cache makes every load revalidate (a 304 when nothing changed).
test("every file is served so that browsers revalidate it", () => {
  const h = fs.readFileSync(path.join(__dirname, "..", "site", "_headers"), "utf8");
  assert.match(h, /^\/\*\n(?:  .*\n)*  Cache-Control: no-cache$/m);
});
