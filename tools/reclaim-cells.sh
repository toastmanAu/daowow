#!/usr/bin/env bash
# Reclaim the capacity locked in superseded code cells.
#
# Consuming a code cell is IRREVERSIBLE. If anything still depends on the
# binary it becomes unspendable, so this script refuses to touch a cell that
# any live cell on chain still references — checked across the whole chain in
# prefix mode, under every hash type, as both lock and type, not merely within
# this wallet.
#
# It also refuses a cell holding a binary that is CURRENTLY built in target/,
# because that is the live version of a contract rather than a superseded one.
# Nothing on chain distinguishes "unreferenced" from "still wanted": a contract
# left unchanged by a rebuild has no references yet is still the deployment in
# use. dao-lock is exactly that case.
#
# It never signs on its own. Without --send it builds the transaction, prints
# what it would do, and stops. Signing prompts ckb-cli for your password; no
# key material is read, stored or logged by this script.
#
# Usage:
#   tools/reclaim-cells.sh [--send] <txhash:index> [<txhash:index> ...]
#
# Example — the four superseded DAOWOW cells (NOT dao-lock, which is
# unchanged and must keep its out point):
#   tools/reclaim-cells.sh \
#     0xb536d389...:0 0x41169f0d...:0 0xb536d389...:1 0x41169f0d...:1
set -euo pipefail

ADDR="${ADDR:-ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqd8w6ls95vu473hf8vsdnpvn2cu785qlac0rckws}"
LOCKARG="${LOCKARG:-0xa776bf02d19cafa3749d906cc2c9ab1cf1e80ff7}"
CKB_URL="${CKB_URL:-http://192.168.68.134:8114}"
FEE_SHANNONS="${FEE_SHANNONS:-10000000}"   # 0.1 CKB
TX_FILE="${TX_FILE:-reclaim.json}"

SEND=0
if [ "${1:-}" = "--send" ]; then SEND=1; shift; fi
if [ $# -eq 0 ]; then
  sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
fi

rpc() {
  curl -s -X POST "$CKB_URL" -H 'Content-Type: application/json' \
    -d "{\"id\":1,\"jsonrpc\":\"2.0\",\"method\":\"$1\",\"params\":$2}"
}

echo "node    $CKB_URL"
echo "address ${ADDR:0:28}..."
echo

total=0
declare -a HASHES INDICES
for outpoint in "$@"; do
  txhash="${outpoint%%:*}"
  index="${outpoint##*:}"
  hexindex="0x$(printf '%x' "$index")"

  cell="$(rpc get_live_cell "[{\"tx_hash\":\"$txhash\",\"index\":\"$hexindex\"},true]")"
  status="$(printf '%s' "$cell" | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["status"])')"
  if [ "$status" != "live" ]; then
    echo "REFUSING: ${txhash:0:14}...:$index is '$status', not live." >&2
    exit 1
  fi

  read -r capacity datahash <<<"$(printf '%s' "$cell" | python3 -c '
import sys, json
c = json.load(sys.stdin)["result"]["cell"]
print(int(c["output"]["capacity"], 16), c["data"]["hash"] if c["data"] else "none")')"

  # The safety check that matters: is this binary still in use anywhere?
  users=0
  for ht in data data1 data2; do
    for st in type lock; do
      n="$(rpc get_cells "[{\"script\":{\"code_hash\":\"$datahash\",\"hash_type\":\"$ht\",\"args\":\"0x\"},\"script_type\":\"$st\",\"script_search_mode\":\"prefix\"},\"asc\",\"0x5\",null]" \
        | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["result"]["objects"]))')"
      users=$((users + n))
    done
  done
  if [ "$users" -ne 0 ]; then
    echo "REFUSING: ${txhash:0:14}...:$index is still referenced by $users live cell(s)." >&2
    echo "  data hash $datahash" >&2
    echo "  Consuming it would strand them. Nothing has been built or sent." >&2
    exit 1
  fi

  current="$(python3 tools/which-local-binary.py "$datahash")"
  if [ -n "$current" ]; then
    echo "REFUSING: ${txhash:0:14}...:$index holds the CURRENT build of '$current'." >&2
    echo "  It is unreferenced only because nothing uses it yet, not because it" >&2
    echo "  is superseded. Reclaiming it would force a pointless redeploy." >&2
    exit 1
  fi

  printf '  reclaim %s...:%-2s %12s CKB  superseded, unreferenced\n' \
    "${txhash:0:14}" "$index" "$((capacity / 100000000))"
  total=$((total + capacity))
  HASHES+=("$txhash"); INDICES+=("$index")
done

output=$((total - FEE_SHANNONS))
echo
printf '  inputs  %s CKB\n' "$((total / 100000000))"
printf '  output  %s.%08d CKB  (fee %s shannons)\n' \
  "$((output / 100000000))" "$((output % 100000000))" "$FEE_SHANNONS"
echo

rm -f "$TX_FILE"
ckb-cli --url "$CKB_URL" tx init --tx-file "$TX_FILE" >/dev/null 2>&1
for i in "${!HASHES[@]}"; do
  ckb-cli --url "$CKB_URL" tx add-input --tx-file "$TX_FILE" \
    --tx-hash "${HASHES[$i]}" --index "${INDICES[$i]}" >/dev/null 2>&1
done
# ckb-cli takes capacity in CKB with decimals, not shannons.
ckb-cli --url "$CKB_URL" tx add-output --tx-file "$TX_FILE" \
  --capacity "$(printf '%s.%08d' "$((output / 100000000))" "$((output % 100000000))")" \
  --to-sighash-address "$ADDR" >/dev/null 2>&1

echo "=== ckb-cli tx info ==="
ckb-cli --url "$CKB_URL" tx info --tx-file "$TX_FILE"
echo

if [ "$SEND" -ne 1 ]; then
  echo "Built $TX_FILE and stopped. Nothing was signed or sent."
  echo "Review the totals above, then re-run with --send."
  exit 0
fi

echo "Signing (ckb-cli will prompt for your password) and sending..."
ckb-cli --url "$CKB_URL" tx sign-inputs --tx-file "$TX_FILE" \
  --from-account "$LOCKARG" --add-signatures
ckb-cli --url "$CKB_URL" tx send --tx-file "$TX_FILE"
echo
echo "Sent. Confirm with:"
echo "  node tools/audit-wallet-cells.mjs \"$ADDR\" \"$CKB_URL\""
