"""Actual excluded-entry refund on the disposable DAOWOW chain."""

import copy

from node_harness import IsolatedNode
from reorg_history import relay_block
from settlement_reorg import assert_committed, live_cell, overtake, relay_tail
from test_native_dao import CKB, commit, input_cell


def refund_excluded_entry(
    case,
    node,
    exported,
    deps,
    init,
    ledger_hash,
    entry_hash,
    participant,
    *,
    reorg=False,
    entry_index=1,
    sponsor_index=1,
):
    since = int(exported["since"], 16)
    case.assertEqual(since, 0x2000000000000004)
    sponsor = copy.deepcopy(init["outputs"][1])
    sponsor["capacity"] = hex(int(sponsor["capacity"], 16) - 100_000)
    close = {
        "version": "0x0",
        "cell_deps": deps,
        "header_deps": [],
        "inputs": [
            input_cell(ledger_hash, 0, since),
            input_cell(ledger_hash, sponsor_index),
        ],
        "outputs": [init["outputs"][0], sponsor],
        "outputs_data": [exported["closed_ledger"], "0x"],
        "witnesses": ["0x", "0x"],
    }
    with case.assertRaisesRegex(RuntimeError, "Immature"):
        node.rpc("send_transaction", [close, "passthrough"])
    for _ in range(30):
        if int(node.rpc("get_tip_header")["epoch"], 16) & 0xFFFFFF >= 4:
            break
        node.rpc("generate_block")
    else:
        case.fail("refund deadline not reached")
    premature = copy.deepcopy(close)
    premature["inputs"][0]["since"] = "0x2000000000000002"
    with case.assertRaisesRegex(RuntimeError, "ValidationFailure"):
        node.rpc("send_transaction", [premature, "passthrough"])
    closed_hash, _ = commit(node, close)
    live = node.rpc("get_live_cell", [{"tx_hash": closed_hash, "index": "0x0"}, True])
    case.assertEqual(live["status"], "live")
    case.assertEqual(live["cell"]["data"]["content"], exported["closed_ledger"])
    sponsor = copy.deepcopy(sponsor)
    sponsor["capacity"] = hex(int(sponsor["capacity"], 16) - 100_000)
    # Separate sponsor identity prevents change from satisfying the refund.
    sponsor["lock"]["args"] = "0x73706f6e736f72"
    refund = {
        "version": "0x0",
        "header_deps": [],
        "cell_deps": deps
        + [{"out_point": {"tx_hash": closed_hash, "index": "0x0"}, "dep_type": "code"}],
        "inputs": [
            input_cell(entry_hash, entry_index, since),
            input_cell(closed_hash, 1),
        ],
        "outputs": [
            {"capacity": hex(400 * CKB), "lock": participant, "type": None},
            sponsor,
        ],
        "outputs_data": ["0x", "0x"],
        "witnesses": [exported["witness"], "0x"],
    }
    missing = copy.deepcopy(refund)
    missing["cell_deps"].pop()
    early = copy.deepcopy(refund)
    early["inputs"][0]["since"] = "0x2000000000000003"
    underpaid = copy.deepcopy(refund)
    underpaid["outputs"][0]["capacity"] = hex(400 * CKB - 1)
    underpaid["outputs"][1]["capacity"] = hex(int(sponsor["capacity"], 16) + 1)
    bad_proof = copy.deepcopy(refund)
    bad_proof["witnesses"][0] = "0x"
    nonordinary = copy.deepcopy(refund)
    nonordinary["outputs_data"][0] = "0x01"
    if entry_index == 3:
        wrong_entry_proof = copy.deepcopy(refund)
        wrong_entry_proof["witnesses"][0] = exported["accepted_witness"]
        with case.assertRaisesRegex(RuntimeError, "ValidationFailure"):
            node.rpc("send_transaction", [wrong_entry_proof, "passthrough"])
    for label, invalid in [
        ("missing authority", missing),
        ("early since", early),
        ("underpayment", underpaid),
        ("missing proof", bad_proof),
        ("nonordinary refund", nonordinary),
    ]:
        with case.subTest(rejection=label):
            with case.assertRaisesRegex(RuntimeError, "ValidationFailure"):
                node.rpc("send_transaction", [invalid, "passthrough"])
    before = (
        [live_cell(node, cell["previous_output"]) for cell in refund["inputs"]]
        if reorg
        else []
    )
    refund_hash, header = commit(node, refund)
    paid = node.rpc("get_live_cell", [{"tx_hash": refund_hash, "index": "0x0"}, True])
    case.assertEqual(paid["status"], "live")
    case.assertEqual(paid["cell"]["output"], refund["outputs"][0])
    case.assertEqual(paid["cell"]["data"]["content"], "0x")
    spent = node.rpc(
        "get_live_cell", [{"tx_hash": entry_hash, "index": hex(entry_index)}, True]
    )
    case.assertIn(spent["status"], ("dead", "unknown"))
    committed = node.rpc("get_transaction", [refund_hash])
    case.assertEqual(committed["transaction"]["inputs"], refund["inputs"])
    print(
        "DAOWOW excluded entry fully refunded",
        refund_hash,
        header["number"],
        "capacity",
        400 * CKB,
        flush=True,
    )
    if reorg:
        recover_refund(case, node, refund, refund_hash, before)
    return {
        "closed_hash": closed_hash,
        "refund_hash": refund_hash,
        "transaction": refund,
    }


def recover_refund(case, node, refund, old_hash, before):
    header = assert_committed(case, node, old_hash)
    prefix = int(header["number"], 16) - 1
    case.assertLess(prefix, 100)
    with IsolatedNode("second", daowow=True) as fork:
        case.assertEqual(
            node.rpc("get_block_hash", ["0x0"]), fork.rpc("get_block_hash", ["0x0"])
        )
        for height in range(1, prefix + 1):
            relay_block(case, node, fork, height)
        overtake(case, fork, node)
        case.assertNotEqual(
            node.rpc("get_transaction", [old_hash])["tx_status"]["status"], "committed"
        )
        for index in (0, 1):
            case.assertIn(
                live_cell(node, {"tx_hash": old_hash, "index": hex(index)})["status"],
                ("unknown", "dead"),
            )
        for cell, expected in zip(refund["inputs"], before):
            case.assertEqual(expected["status"], "live")
            case.assertEqual(live_cell(node, cell["previous_output"]), expected)
        recovered = copy.deepcopy(refund)
        recovered["outputs"][1]["capacity"] = hex(
            int(recovered["outputs"][1]["capacity"], 16) - 100_000
        )
        underpaid = copy.deepcopy(recovered)
        underpaid["outputs"][0]["capacity"] = hex(400 * CKB - 1)
        underpaid["outputs"][1]["capacity"] = hex(
            int(recovered["outputs"][1]["capacity"], 16) + 1
        )
        with case.assertRaisesRegex(RuntimeError, "ValidationFailure"):
            fork.rpc("send_transaction", [underpaid, "passthrough"])
        start = int(fork.rpc("get_tip_header")["number"], 16) + 1
        recovered_hash, _ = commit(fork, recovered)
        case.assertNotEqual(recovered_hash, old_hash)
        relay_tail(case, fork, node, start)
        assert_committed(case, node, recovered_hash)
        paid = live_cell(node, {"tx_hash": recovered_hash, "index": "0x0"})
        case.assertEqual(paid["status"], "live")
        case.assertEqual(paid["cell"]["output"], refund["outputs"][0])
        case.assertEqual(int(paid["cell"]["output"]["capacity"], 16), 400 * CKB)
        case.assertEqual(paid["cell"]["data"]["content"], "0x")
        for cell in refund["inputs"]:
            case.assertIn(
                live_cell(node, cell["previous_output"])["status"], ("unknown", "dead")
            )
        case.assertIn(
            live_cell(node, {"tx_hash": old_hash, "index": "0x0"})["status"],
            ("unknown", "dead"),
        )
        duplicate = copy.deepcopy(recovered)
        duplicate["outputs"][1]["capacity"] = hex(
            int(duplicate["outputs"][1]["capacity"], 16) - 100_000
        )
        with case.assertRaisesRegex(RuntimeError, "Unknown|Dead|Resolve"):
            fork.rpc("send_transaction", [duplicate, "passthrough"])
        print(
            "DAOWOW orphaned refund recovered",
            old_hash,
            recovered_hash,
            "capacity",
            400 * CKB,
            flush=True,
        )
