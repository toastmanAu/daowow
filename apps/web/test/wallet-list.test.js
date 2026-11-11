"use strict";
// The wallet picker lists what CCC reports, unfiltered: upstream decides which
// wallets exist. What this module owns is turning that report into choices a
// player can read, and never treating a download link as a wallet.
const { test } = require("node:test");
const assert = require("node:assert");
const { describeWallets, rememberedChoice, optionKey } = require("../chain/wallet-list.js");

const real = (name) => ({ name, signer: { real: true } });
const link = (name) => ({ name, signer: { real: false } });
const isInstall = (signer) => !signer.real;
const ICON = "data:image/svg+xml;base64,AAAA";
const report = [
  { name: "MetaMask", icon: ICON, signers: [link("EVM")] },
  { name: "JoyID Passkey", icon: ICON, signers: [real("CKB"), real("BTC")] },
  { name: "Rabby", icon: "https://rabby.example/icon.png", signers: [real("EVM")] },
  { name: "OKX Wallet", icon: ICON, signers: [link("EVM"), link("BTC")] },
];

test("every signer of every wallet upstream reports is offered", () => {
  const options = describeWallets(report, isInstall);
  assert.deepStrictEqual(options.filter((o) => !o.install).map((o) => o.label),
    ["JoyID Passkey (CKB)", "JoyID Passkey (BTC)", "Rabby"]);
});

test("a wallet that is not installed appears once, as a download link, after the usable ones", () => {
  const options = describeWallets(report, isInstall);
  assert.deepStrictEqual(options.map((o) => o.install), [false, false, false, true, true]);
  assert.deepStrictEqual(options.filter((o) => o.install).map((o) => o.label), ["MetaMask", "OKX Wallet"]);
});

test("keys are unique and name both the wallet and the signer", () => {
  const options = describeWallets(report, isInstall);
  assert.strictEqual(new Set(options.map((o) => o.key)).size, options.length);
  assert.strictEqual(options[0].key, optionKey("JoyID Passkey", "CKB"));
  assert.notStrictEqual(optionKey("a", "b c"), optionKey("a b", "c"));
});

test("only an inline image is used as an icon, never a remote address", () => {
  const options = describeWallets(report, isInstall);
  assert.strictEqual(options.find((o) => o.label === "Rabby").icon, null);
  assert.strictEqual(options[0].icon, ICON);
  const sneaky = describeWallets([{ name: "X", icon: "javascript:alert(1)", signers: [real("CKB")] }], isInstall);
  assert.strictEqual(sneaky[0].icon, null);
});

test("each choice carries its own signer", () => {
  const options = describeWallets(report, isInstall);
  assert.strictEqual(options[1].signer, report[1].signers[1].signer);
});

test("a remembered wallet is restored only if it is present and usable", () => {
  const options = describeWallets(report, isInstall);
  assert.strictEqual(rememberedChoice(options, optionKey("Rabby", "EVM")).label, "Rabby");
  assert.strictEqual(rememberedChoice(options, optionKey("MetaMask", "EVM")), null);
  assert.strictEqual(rememberedChoice(options, optionKey("Gone", "CKB")), null);
  assert.strictEqual(rememberedChoice(options, null), null);
});

test("an empty or malformed report offers nothing and does not throw", () => {
  assert.deepStrictEqual(describeWallets([], isInstall), []);
  assert.deepStrictEqual(describeWallets(undefined, isInstall), []);
  assert.deepStrictEqual(describeWallets([{ name: "Y", icon: ICON, signers: [] }], isInstall), []);
});

test("a wallet that is installed is not also offered as a download", () => {
  const mixed = [{ name: "OKX Wallet", icon: ICON, signers: [real("BTC"), link("EVM")] }];
  const options = describeWallets(mixed, isInstall);
  assert.deepStrictEqual(options.map((o) => [o.label, o.install]), [["OKX Wallet", false]]);
});
