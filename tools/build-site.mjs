#!/usr/bin/env node
// Assembles the public site for daowow.org.
//
// This is a COPY, not a build: no file is transformed, bundled or generated.
// What it adds is a boundary. The repository holds contracts, tools, tests, a
// prototype simulator and a manifest naming a private node; only the files
// listed here are published, and the copy stops if any of them names a
// private address.
//
//   node tools/build-site.mjs [outDir=dist/site]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB = path.join(ROOT, "apps", "web");

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);

/** Every file the site serves, as { from: absolute path, to: path on the site }. */
export function listSiteFiles() {
  const files = [{ from: path.join(WEB, "core.js"), to: "core.js" }];
  for (const name of fs.readdirSync(path.join(WEB, "chain")).sort()) {
    if (name.endsWith(".js")) files.push({ from: path.join(WEB, "chain", name), to: `chain/${name}` });
  }
  for (const name of fs.readdirSync(path.join(WEB, "vendor")).sort()) {
    if (name.endsWith(".md")) continue; // notes for developers, not for the site
    files.push({ from: path.join(WEB, "vendor", name), to: `vendor/${name}` });
  }
  for (const from of walk(path.join(WEB, "dapp")).sort()) {
    files.push({ from, to: `dapp/${path.relative(path.join(WEB, "dapp"), from).split(path.sep).join("/")}` });
  }
  // Cloudflare Pages reads these two from the site root.
  for (const name of ["_headers", "_redirects"]) {
    files.push({ from: path.join(WEB, "site", name), to: name });
  }
  return files;
}

/**
 * Private addresses a published file must never carry. The vendored wallet
 * library names localhost in its own defaults, so that one word is allowed
 * under vendor/ and nowhere else.
 */
export function leaks(to, text) {
  const found = [];
  if (text.includes("192.168.")) found.push("192.168.");
  if (!to.startsWith("vendor/") && /localhost|127\.0\.0\.1/.test(text)) found.push("localhost");
  return found;
}

export function buildSite(outDir) {
  const files = listSiteFiles();
  for (const { from, to } of files) {
    const bad = leaks(to, fs.readFileSync(from, "utf8"));
    if (bad.length > 0) throw new Error(`refusing to publish ${to}: it names ${bad.join(" and ")}`);
  }
  fs.rmSync(outDir, { recursive: true, force: true });
  for (const { from, to } of files) {
    const target = path.join(outDir, to);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(from, target);
  }
  return files.length;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outDir = path.resolve(process.argv[2] ?? path.join(ROOT, "dist", "site"));
  try {
    const count = buildSite(outDir);
    console.log(`site: ${count} files copied to ${path.relative(process.cwd(), outDir) || "."}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
