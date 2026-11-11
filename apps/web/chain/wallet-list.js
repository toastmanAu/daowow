"use strict";
// Wrapped in an IIFE: loaded as a classic script these files share one
// global scope, so top-level declarations would collide between modules.
(function () {
// Turning CCC's wallet report into choices for the picker.
//
// Nothing is filtered by name: which wallets exist is upstream's decision, and
// a wallet CCC adds appears here without a change to this app. What is decided
// here is only how a choice reads, and that a download link is never offered
// as though it were a wallet.

// A separator no wallet or signer name contains, so two names cannot be
// rearranged into the same key.
const SEPARATOR = "\u001f";
const optionKey = (wallet, signerName) => `${wallet}${SEPARATOR}${signerName}`;

// Icons come from the wallet itself. Only an inline image is shown: a remote
// one is a request to someone else's server, and anything else is not an image.
const inlineImage = (icon) =>
  (typeof icon === "string" && /^data:image\/(svg\+xml|png|webp|jpeg|gif)[;,]/.test(icon) ? icon : null);

/**
 * `wallets` is CCC's report: [{ name, icon, signers: [{ name, signer }] }].
 * `isInstall(signer)` says whether a signer is only a link to get the wallet.
 * Usable choices come first, in upstream's order; then one download link for
 * each wallet that has nothing else.
 */
function describeWallets(wallets, isInstall) {
  const usable = [];
  const links = [];
  for (const wallet of Array.isArray(wallets) ? wallets : []) {
    const signers = Array.isArray(wallet.signers) ? wallet.signers : [];
    const real = signers.filter((s) => !isInstall(s.signer));
    const icon = inlineImage(wallet.icon);
    for (const s of real) {
      usable.push({
        key: optionKey(wallet.name, s.name),
        label: real.length === 1 ? wallet.name : `${wallet.name} (${s.name})`,
        wallet: wallet.name, icon, install: false, signer: s.signer,
      });
    }
    if (real.length === 0 && signers.length > 0) {
      links.push({
        key: optionKey(wallet.name, signers[0].name),
        label: wallet.name,
        wallet: wallet.name, icon, install: true, signer: signers[0].signer,
      });
    }
  }
  return [...disambiguate(usable), ...links];
}

// Browser wallets name themselves, and nothing stops two of them giving the
// same name. Such choices cannot be told apart by anything a player can read,
// so each gets its own key (a click must reach the row that was clicked) and
// is marked ambiguous, which keeps it from ever being restored unasked.
function disambiguate(usable) {
  const seen = new Map();
  for (const o of usable) seen.set(o.key, (seen.get(o.key) ?? 0) + 1);
  const nth = new Map();
  return usable.map((o) => {
    if (seen.get(o.key) === 1) return { ...o, ambiguous: false };
    const n = (nth.get(o.key) ?? 0) + 1;
    nth.set(o.key, n);
    return { ...o, key: `${o.key}${SEPARATOR}${n}`, label: `${o.label} #${n}`, ambiguous: true };
  });
}

/**
 * The usable choice with this key, or null. A download link is never restored,
 * and neither is a wallet that shares its name with another.
 */
function rememberedChoice(options, key) {
  if (typeof key !== "string") return null;
  return options.find((o) => o.key === key && !o.install && !o.ambiguous) ?? null;
}

const api = { describeWallets, rememberedChoice, optionKey };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.DaowowWalletList = api;
})();
