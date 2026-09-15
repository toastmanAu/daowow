/* Display-only preview. No wallet, RPC, signing, storage or transaction builder. */
(function (root) {
  "use strict";
  function selection(value) {
    const raw = String(value);
    if (!/^[0-9]{1,3}$/.test(raw) || Number(raw) < 1 || Number(raw) > 100) {
      throw new RangeError("Choose a whole number from 1 to 100.");
    }
    const tickets = Number(raw);
    return { tickets, principal: BigInt(tickets) * 10000000000n, total: null, canSubmit: false };
  }
  function formatCkb(shannons) {
    const whole = (shannons / 100000000n).toLocaleString("en-US");
    const fraction = (shannons % 100000000n).toString().padStart(8, "0").replace(/0+$/, "");
    return whole + (fraction ? "." + fraction : "");
  }
  const api = Object.freeze({ selection, formatCkb });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DaowowEntry = api;
})(globalThis);
