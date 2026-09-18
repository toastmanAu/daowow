// JoyID connection, exposing address and balance ONLY.
//
// Gate 2a is read-only: no transaction is built, signed or sent anywhere in
// it (spec non-goals). The CCC signer object does carry signTransaction,
// sendTransaction and friends, so this module keeps the signer PRIVATE in a
// closure and hands back a frozen session with only read operations on it.
// That makes the restriction structural rather than a naming convention a
// later edit could quietly step over.
//
// Signing arrives in 2b, and the spec records an obligation to settle first:
// a redirect/relay broker renders the human-readable preview a user approves
// while JoyID itself displays only a hash, which makes the relay a trusted
// component in the signing path rather than mere transport.

import { ccc, joyid } from "../vendor/ccc-joyid.min.mjs";

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
