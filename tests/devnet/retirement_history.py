"""Sub-project 3 (claim retirement + memento) carried onto the disposable
DAOWOW chain: a non-winner retires once the round is sealed, and a winner
that has redeemed every batch retires with a memento that then transfers
once. Follows the module-per-stage pattern of refund_history.py and
settlement_reorg.py rather than growing test_round_creation.py's own
run_history further.
"""

import copy

from test_native_dao import commit, input_cell


def retire_sealed_round(
    case,
    node,
    protocol_deps,
    entropy_hash,
    retirement,
    entry_hash,
    entry_tx,
    nonwinner_index,
    redeem_hash,
    redeem,
):
    """`retirement` is `funding_export["retirement"]` from the Rust exporter:
    the raw committed prize-schedule bytes `retire()` expects as the group
    input's own witness, plus the winning ticket's fully authenticated
    memento content. `nonwinner_index` is the never-drawn claim's output
    index in `entry_tx` (shard 0, position 1 in the partial fixture)."""
    retire_deps = protocol_deps + [
        {"out_point": {"tx_hash": entropy_hash, "index": "0x0"}, "dep_type": "code"}
    ]

    # A claim that was never drawn owes and is owed nothing: it may retire
    # with no successor as soon as the sealed round and its entropy record
    # are available, recovering its occupied capacity as a plain cell, minus
    # the same 100_000-shannon fee reserve every other step in this suite
    # deducts. An input == output capacity transaction pays zero fee, which
    # the pool rejects with PoolRejectedTransactionByMinFeeRate before any
    # script ever runs — a live-node-only trap the ckb-testtool mock (which
    # has no fee-rate policy) does not surface.
    nonwinner_claim = entry_tx["outputs"][nonwinner_index]
    nonwinner_payout = hex(int(nonwinner_claim["capacity"], 16) - 100_000)
    # NOTE: witnesses[0] here is `retirement["schedule_raw"]` -- the raw
    # PrizeSchedule bytes retire() expects at load_witness(0, GroupInput),
    # NOT a WitnessArgs. This single-input shape only works because the
    # devnet participant lock is a smoke-minimal fixture lock that ignores
    # witness 0 entirely. A real secp256k1_blake160_sighash_all lock needs
    # witness 0 of its own group to decode as a WitnessArgs carrying its
    # 65-byte signature, which collides with the raw schedule bytes at byte
    # 0 (PrizeSchedule::decode requires data[0] == 1; WitnessArgs starts with
    # a 4-byte LE size) -- a signature-locked retire is unbuildable as a
    # single input and needs a second cell under the same lock at a LOWER
    # input index to carry the signature, leaving this slot free for the raw
    # schedule. See docs/superpowers/specs/2026-09-16-claim-retirement-memento-design.md
    # ("Open constraint: the schedule witness slot is unbuildable under a
    # signature lock") and docs/HANDOFF-2026-09-16.md.
    nonwinner_retire = {
        "version": "0x0",
        "cell_deps": retire_deps,
        "header_deps": [],
        "inputs": [input_cell(entry_hash, nonwinner_index)],
        "outputs": [
            {
                "capacity": nonwinner_payout,
                "lock": nonwinner_claim["lock"],
                "type": None,
            }
        ],
        "outputs_data": ["0x"],
        "witnesses": [retirement["schedule_raw"]],
    }
    missing_entropy_dep = copy.deepcopy(nonwinner_retire)
    missing_entropy_dep["cell_deps"] = protocol_deps
    with case.assertRaisesRegex(RuntimeError, "ValidationFailure"):
        node.rpc("send_transaction", [missing_entropy_dep, "passthrough"])
    nonwinner_hash, _ = commit(node, nonwinner_retire)
    live = node.rpc(
        "get_live_cell", [{"tx_hash": nonwinner_hash, "index": "0x0"}, True]
    )
    case.assertEqual(live["status"], "live")
    case.assertIsNone(live["cell"]["output"]["type"])
    case.assertEqual(
        int(live["cell"]["output"]["capacity"], 16),
        int(nonwinner_payout, 16),
    )
    case.assertEqual(live["cell"]["data"]["content"], "0x")
    print(
        "DAOWOW non-winner claim retired",
        nonwinner_hash,
        "capacity",
        nonwinner_payout,
        flush=True,
    )

    # The winning claim already redeemed the round's one batch (paid_count
    # == universe == 1), so it may retire, minting exactly one memento of
    # its identity under its own holder lock. Minted with a 100_000-shannon
    # buffer above the memento's own bare occupied capacity, so the transfer
    # below can pay its own fee reserve without dropping under the memento's
    # minimum required capacity (a system-level rejection, not a script one,
    # that a mint at the exact minimum would hit on the very next spend).
    memento = retirement["memento"]
    winner_claim = redeem["outputs"][1]
    memento_mint_capacity = hex(int(memento["capacity"], 16) + 100_000)
    # Same single-input-under-a-fixture-lock caveat as nonwinner_retire above:
    # witnesses[0] is the raw schedule, not a WitnessArgs, and this shape is
    # only buildable because the fixture lock ignores witness 0.
    winner_retire = {
        "version": "0x0",
        "cell_deps": retire_deps,
        "header_deps": [],
        "inputs": [input_cell(redeem_hash, 1)],
        "outputs": [
            {
                "capacity": memento_mint_capacity,
                "lock": winner_claim["lock"],
                "type": memento["type"],
            }
        ],
        "outputs_data": [memento["data"]],
        "witnesses": [retirement["schedule_raw"]],
    }
    wrong_memento_lock = copy.deepcopy(winner_retire)
    wrong_memento_lock["outputs"][0]["lock"] = {
        **winner_claim["lock"],
        "args": "0x73706f6e736f72",
    }
    with case.assertRaisesRegex(RuntimeError, "ValidationFailure"):
        node.rpc("send_transaction", [wrong_memento_lock, "passthrough"])
    winner_hash, _ = commit(node, winner_retire)
    live = node.rpc("get_live_cell", [{"tx_hash": winner_hash, "index": "0x0"}, True])
    case.assertEqual(live["status"], "live")
    case.assertEqual(live["cell"]["output"], winner_retire["outputs"][0])
    case.assertEqual(live["cell"]["data"]["content"], memento["data"])
    print(
        "DAOWOW winning claim retired with memento",
        winner_hash,
        flush=True,
    )

    # The memento is non-financial and carries no rights: it transfers under
    # a plain lock change with no authenticating witness at all (paying its
    # fee out of the mint-time buffer above; a zero-fee lock-only change is
    # otherwise pool-rejected before the memento script ever runs, and this
    # exactly restores the memento's bare minimum capacity rather than
    # dropping under it). It still needs `protocol_deps` as a cell dep: the
    # input's own holder LOCK script (the fixture's smoke-minimal code) must
    # be loadable regardless of whether any type script cares, exactly like
    # every other transaction in this file that spends a fixture-locked cell
    # (e.g. `payout` above) — an empty `cell_deps` here is ScriptNotFound on
    # `Inputs[0].Lock`, not a memento-content rejection.
    transfer_lock = {**winner_claim["lock"], "args": "0x73706f6e736f72"}
    transfer_capacity = hex(int(memento_mint_capacity, 16) - 100_000)
    case.assertEqual(transfer_capacity, memento["capacity"])
    memento_transfer = {
        "version": "0x0",
        "cell_deps": protocol_deps,
        "header_deps": [],
        "inputs": [input_cell(winner_hash, 0)],
        "outputs": [
            {
                "capacity": transfer_capacity,
                "lock": transfer_lock,
                "type": memento["type"],
            }
        ],
        "outputs_data": [memento["data"]],
        "witnesses": ["0x"],
    }
    transfer_hash, _ = commit(node, memento_transfer)
    live = node.rpc(
        "get_live_cell", [{"tx_hash": transfer_hash, "index": "0x0"}, True]
    )
    case.assertEqual(live["status"], "live")
    case.assertEqual(live["cell"]["output"]["lock"], transfer_lock)
    case.assertEqual(live["cell"]["data"]["content"], memento["data"])
    print(
        "DAOWOW memento transferred",
        transfer_hash,
        flush=True,
    )
    return {
        "nonwinner_hash": nonwinner_hash,
        "winner_hash": winner_hash,
        "transfer_hash": transfer_hash,
    }
