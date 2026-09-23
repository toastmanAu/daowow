// JoyID connection.
//
// Gate 2a was read-only and kept the CCC signer PRIVATE in a closure, handing
// back a frozen session carrying only read operations. Gate 2b needs signing,
// and the closure stays: the session gains two NAMED operations rather than
// the signer itself. An entry can be signed and an entry can be broadcast;
// nothing else the signer can do is reachable from a page. That keeps the
// restriction structural rather than a naming convention a later edit could
// quietly step over.
//
// The spec's standing obligation is unchanged and unsettled: a redirect/relay
// broker renders the human-readable preview a user approves while JoyID itself
// displays only a hash, which makes the relay a trusted component in the
// signing path rather than mere transport.

import { ccc, joyid } from "../vendor/ccc-joyid.min.mjs";
import { prepareAndSignEntry, broadcastEntry } from "./sign-entry.js";

export function createWallet({ rpcUrl, appName = "DAOWOW", appIcon = "" }) {
  if (!rpcUrl) throw new Error("wallet needs an rpcUrl from the manifest");

  const client = new ccc.ClientPublicTestnet({ url: rpcUrl });
  // Private. Never returned, never attached to the session object.
  const signer = new joyid.JoyId.CkbSigner(client, appName, appIcon);

  const session = async () => {
    const address = await signer.getRecommendedAddress();
    const { script } = await ccc.Address.fromString(address, client);
    return Object.freeze({
      address,
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

  return Object.freeze({
    async connect() {
      await signer.connect();
      return await session();
    },
    // Returns a session if a previous connection is still valid, else null.
    // Used on page load so a returning visitor is not asked to reconnect.
    async restore() {
      try {
        if (!(await signer.isConnected())) return null;
        return await session();
      } catch {
        return null;
      }
    },
    async isConnected() {
      try {
        return await signer.isConnected();
      } catch {
        return false;
      }
    },
    async disconnect() {
      await signer.disconnect();
    },
    client,
  });
}
