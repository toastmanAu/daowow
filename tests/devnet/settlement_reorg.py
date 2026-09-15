"""Bounded actual funding/payout rollback and recovery, without wallet access."""

import copy

from node_harness import IsolatedNode
from reorg_history import relay_block
from test_native_dao import commit, input_cell


def live_cell(node, out_point):
    return node.rpc("get_live_cell", [out_point, True])


def assert_committed(case, node, tx_hash):
    status = node.rpc("get_transaction", [tx_hash])["tx_status"]
    case.assertEqual(status["status"], "committed")
    header = node.rpc("get_header", [status["block_hash"]])
    case.assertEqual(
        node.rpc("get_block_hash", [header["number"]]), status["block_hash"]
    )
    return header


def overtake(case, fork, node):
    """Fork has the common prefix and no orphan transaction in its pool."""
    old_tip = node.rpc("get_tip_header")
    common_tip = fork.rpc("get_tip_header")
    start = int(common_tip["number"], 16) + 1
    count = int(old_tip["number"], 16) - int(common_tip["number"], 16) + 2
    case.assertGreater(count, 0)
    case.assertLess(count, 30)
    for _ in range(count):
        fork.rpc("generate_block")
    relay_tail(case, fork, node, start)
    case.assertNotEqual(
        node.rpc("get_block_hash", [old_tip["number"]]), old_tip["hash"]
    )


def relay_tail(case, source, destination, start):
    tip = source.rpc("get_tip_header")
    for height in range(start, int(tip["number"], 16) + 1):
        relay_block(case, source, destination, height)
    case.assertEqual(destination.rpc("get_tip_header")["hash"], tip["hash"])


def recover_settlement_history(case, node, funding, funding_hash, payout, payout_hash):
    funding_header = assert_committed(case, node, funding_hash)
    assert_committed(case, node, payout_hash)
    prefix = int(funding_header["number"], 16) - 1
    case.assertLess(prefix, 4000)
    with IsolatedNode("second", daowow=True) as fork:
        case.assertEqual(
            node.rpc("get_block_hash", ["0x0"]), fork.rpc("get_block_hash", ["0x0"])
        )
        for height in range(1, prefix + 1):
            relay_block(case, node, fork, height)
            if height % 600 == 0:
                print(
                    "DAOWOW recovery shared-history relay",
                    height,
                    "of",
                    prefix,
                    flush=True,
                )
        overtake(case, fork, node)
        for tx_hash in (funding_hash, payout_hash):
            case.assertIn(
                live_cell(node, {"tx_hash": tx_hash, "index": "0x0"})["status"],
                ("unknown", "dead"),
            )
            case.assertNotEqual(
                node.rpc("get_transaction", [tx_hash])["tx_status"]["status"],
                "committed",
            )
        for cell in funding["inputs"]:
            case.assertEqual(live_cell(node, cell["previous_output"])["status"], "live")
        # Fresh fork never received the old mempool chain. Its orphan payout
        # fails to resolve before canonical funding exists.
        with case.assertRaisesRegex(RuntimeError, "Unknown|Dead|Resolve"):
            fork.rpc("send_transaction", [payout, "passthrough"])
        rebuilt = copy.deepcopy(funding)
        rebuilt["outputs"][1]["capacity"] = hex(
            int(rebuilt["outputs"][1]["capacity"], 16) - 100_000
        )
        start = int(fork.rpc("get_tip_header")["number"], 16) + 1
        recovered_hash, _ = commit(fork, rebuilt)
        case.assertNotEqual(recovered_hash, funding_hash)
        relay_tail(case, fork, node, start)
        assert_committed(case, node, recovered_hash)
        recovered = live_cell(node, {"tx_hash": recovered_hash, "index": "0x0"})
        case.assertEqual(recovered["status"], "live")
        case.assertEqual(recovered["cell"]["output"], funding["outputs"][0])
        case.assertEqual(
            recovered["cell"]["data"]["content"], funding["outputs_data"][0]
        )
        print(
            "DAOWOW orphaned funding recovered",
            funding_hash,
            recovered_hash,
            flush=True,
        )
        # Commit a payout only on the original node; the fork remains at funding.
        candidate = copy.deepcopy(payout)
        candidate["inputs"] = [
            input_cell(recovered_hash, 0),
            input_cell(recovered_hash, 1),
        ]
        candidate["outputs"][1]["capacity"] = hex(
            int(candidate["outputs"][1]["capacity"], 16) - 100_000
        )
        orphan_payout, _ = commit(node, candidate)
        assert_committed(case, node, orphan_payout)
        overtake(case, fork, node)
        case.assertIn(
            live_cell(node, {"tx_hash": orphan_payout, "index": "0x0"})["status"],
            ("unknown", "dead"),
        )
        case.assertNotEqual(
            node.rpc("get_transaction", [orphan_payout])["tx_status"]["status"],
            "committed",
        )
        restored = live_cell(node, {"tx_hash": recovered_hash, "index": "0x0"})
        case.assertEqual(restored["status"], "live")
        case.assertEqual(restored["cell"], recovered["cell"])
        final = copy.deepcopy(candidate)
        final["outputs"][1]["capacity"] = hex(
            int(final["outputs"][1]["capacity"], 16) - 100_000
        )
        start = int(fork.rpc("get_tip_header")["number"], 16) + 1
        final_hash, _ = commit(fork, final)
        case.assertNotEqual(final_hash, orphan_payout)
        relay_tail(case, fork, node, start)
        assert_committed(case, node, final_hash)
        paid = live_cell(node, {"tx_hash": final_hash, "index": "0x0"})
        case.assertEqual(paid["status"], "live")
        case.assertEqual(paid["cell"]["output"], payout["outputs"][0])
        case.assertEqual(paid["cell"]["data"]["content"], "0x")
        for cell in final["inputs"]:
            case.assertIn(
                live_cell(node, cell["previous_output"])["status"], ("unknown", "dead")
            )
        for old_hash in (funding_hash, payout_hash, orphan_payout):
            case.assertIn(
                live_cell(node, {"tx_hash": old_hash, "index": "0x0"})["status"],
                ("unknown", "dead"),
            )
        duplicate = copy.deepcopy(final)
        duplicate["outputs"][1]["capacity"] = hex(
            int(duplicate["outputs"][1]["capacity"], 16) - 100_000
        )
        with case.assertRaisesRegex(RuntimeError, "Unknown|Dead|Resolve"):
            fork.rpc("send_transaction", [duplicate, "passthrough"])
        print(
            "DAOWOW orphaned payout recovered",
            orphan_payout,
            final_hash,
            "participant capacity",
            int(paid["cell"]["output"]["capacity"], 16),
            flush=True,
        )
