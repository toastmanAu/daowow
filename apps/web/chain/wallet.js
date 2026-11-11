// Wallet connection, for every wallet CCC supports.
//
// Which wallets exist is upstream's decision: the list comes from CCC's own
// SignersController and is not filtered by name here. A wallet CCC adds
// appears in the picker when the vendored bundle is next rebuilt.
//
// The CCC signer stays PRIVATE in this closure. A page receives a frozen
// session carrying read operations and two NAMED signing operations: an entry
// can be signed and an entry can be broadcast; nothing else a signer can do is
// reachable. A choice in the picker is described to the page by key and label
// only, and its signer is looked up here. That keeps the restriction
// structural rather than a naming convention a later edit could step over.
//
// The standing obligation is unchanged: most of these wallets show the player
// a hash to approve, not a readable transaction. The summary this app draws is
// the only description of what is being signed.

import { ccc } from "../vendor/ccc.min.mjs";
import { prepareAndSignEntry, broadcastEntry } from "./sign-entry.js";

const REMEMBER_KEY = "daowow.wallet";
// Browser wallets that announce themselves (EIP-6963) do so shortly after the
// list is first read. A remembered one is waited for this long on page load.
const ANNOUNCE_WAIT_MS = 600;

const list = () => globalThis.DaowowWalletList;

export function createWallet({ rpcUrl, appName = "DAOWOW", appIcon = "", storage = null }) {
  if (!rpcUrl) throw new Error("wallet needs an rpcUrl from the manifest");

  const client = new ccc.ClientPublicTestnet({ url: rpcUrl });
  // Private. Never returned, never attached to a session or a choice.
  let controller = null;
  let options = [];
  let current = null;
  const watchers = new Set();

  const store = () => {
    if (storage) return storage;
    try { return globalThis.localStorage ?? null; } catch { return null; }
  };
  const remember = (key) => {
    try {
      if (key === null) store()?.removeItem(REMEMBER_KEY); else store()?.setItem(REMEMBER_KEY, key);
    } catch { /* a browser that refuses storage simply asks again next time */ }
  };
  const remembered = () => {
    try { return store()?.getItem(REMEMBER_KEY) ?? null; } catch { return null; }
  };

  // What a page may know about a choice: never the signer.
  const publicChoice = (o) => Object.freeze({
    key: o.key, label: o.label, wallet: o.wallet, icon: o.icon, install: o.install,
  });
  const choices = () => options.map(publicChoice);

  async function refresh() {
    controller ??= new ccc.SignersController();
    await controller.refresh(client, (wallets) => {
      options = list().describeWallets(wallets, (signer) => signer instanceof ccc.SignerDummy);
      for (const tell of watchers) tell(choices());
    }, { name: appName, icon: appIcon });
    return choices();
  }

  const session = async (option) => {
    const signer = option.signer;
    const address = await signer.getRecommendedAddress();
    // Every address here must be a testnet one. A wallet that answers for
    // another network is refused before anything is quoted against it.
    if (!address.startsWith("ckt")) {
      throw new Error("this wallet did not give a testnet address");
    }
    const { script } = await ccc.Address.fromString(address, client);
    return Object.freeze({
      address,
      wallet: option.label,
      lockScript: Object.freeze({
        codeHash: script.codeHash,
        hashType: script.hashType,
        args: script.args,
      }),
      // Read on demand rather than cached: a cached balance goes stale and,
      // worse, survives a reorg that invalidated it.
      balance: async () => await signer.getBalance(),
      // The two signing capabilities, kept apart because losing the race for
      // the shard head is a BROADCAST-time outcome the retry loop has to see.
      signEntry: async (description) => await prepareAndSignEntry(signer, description),
      broadcast: async (signedTx) => await broadcastEntry(signer, signedTx),
    });
  };

  const find = (key) => options.find((o) => o.key === key) ?? null;

  return Object.freeze({
    /** Every wallet CCC reports, as choices. Re-reads the browser each call. */
    async wallets() {
      return await refresh();
    },
    /** Calls `tell(choices)` whenever a wallet announces itself later. */
    watch(tell) {
      watchers.add(tell);
      return () => watchers.delete(tell);
    },
    /**
     * Connects the chosen wallet. A download link opens and returns null:
     * there is nothing to connect to yet.
     */
    async connect(key) {
      const option = find(key);
      if (!option) throw new Error("that wallet is no longer available");
      await option.signer.connect();
      if (option.install) return null;
      const made = await session(option);
      current = option;
      remember(option.key);
      return made;
    },
    // Returns a session if the wallet used last time is still connected, else
    // null. Used on page load so a returning visitor is not asked again.
    async restore() {
      try {
        await refresh();
        const key = remembered();
        if (key === null) return null;
        let option = list().rememberedChoice(options, key);
        if (!option) {
          await new Promise((resolve) => setTimeout(resolve, ANNOUNCE_WAIT_MS));
          option = list().rememberedChoice(options, key);
        }
        if (!option || !(await option.signer.isConnected())) return null;
        const made = await session(option);
        current = option;
        return made;
      } catch {
        return null;
      }
    },
    async isConnected() {
      try {
        return current !== null && await current.signer.isConnected();
      } catch {
        return false;
      }
    },
    async disconnect() {
      const was = current;
      current = null;
      remember(null);
      if (was) await was.signer.disconnect();
    },
    client,
  });
}
