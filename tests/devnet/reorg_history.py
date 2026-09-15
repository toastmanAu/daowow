"""Competing canonical branches for the disposable DAOWOW history fixture."""

import copy
import json
import subprocess

from node_harness import IsolatedNode
from test_native_dao import commit, input_cell


def relay_block(case, source, destination, height):
    block = source.rpc("get_block_by_number", [hex(height)])
    expected = block["header"].pop("hash")
    for transaction in block["transactions"]:
        transaction.pop("hash")
    case.assertEqual(destination.rpc("submit_block", ["0x0", block]), expected)


def replace_entropy_branch(
    case,
    node,
    seal_tx,
    seal_header,
    old_entropy_tx,
    old_entropy_hash,
    exporter_command,
    cwd,
    protocol_deps,
):
    """Replace the seal's inclusion and entropy, then prove dep recovery."""
    old_tip = node.rpc("get_tip_header")
    fork_height = int(seal_header["number"], 16) - 1
    case.assertLess(int(old_tip["number"], 16), 400)
    with IsolatedNode("second", daowow=True) as fork:
        case.assertEqual(
            node.rpc("get_block_hash", ["0x0"]), fork.rpc("get_block_hash", ["0x0"])
        )
        for height in range(1, fork_height + 1):
            relay_block(case, node, fork, height)
        # Change both the seal's inclusion height and block hash.
        fork.rpc("generate_block")
        fork.rpc("generate_block")
        seal_hash, canonical_seal = commit(fork, seal_tx)
        height = int(canonical_seal["number"], 16)
        case.assertGreater(height, int(seal_header["number"], 16))
        case.assertNotEqual(canonical_seal["hash"], seal_header["hash"])
        for _ in range(256):
            fork.rpc("generate_block")
        headers = [canonical_seal["hash"]] + [
            fork.rpc("get_block_hash", [hex(height + offset)])
            for offset in (64, 128, 192)
        ]
        exported = json.loads(
            subprocess.run(
                [*exporter_command, str(height), *headers],
                cwd=cwd,
                check=True,
                capture_output=True,
                timeout=30,
            ).stdout
        )
        case.assertEqual(exported["seal"]["data"], seal_tx["outputs_data"][0])
        rebuilt = copy.deepcopy(old_entropy_tx)
        rebuilt["inputs"][0]["previous_output"]["tx_hash"] = seal_hash
        rebuilt["inputs"][1]["previous_output"]["tx_hash"] = seal_hash
        rebuilt["header_deps"] = headers
        rebuilt["outputs_data"][0] = exported["entropy"]
        case.assertNotEqual(
            rebuilt["outputs_data"][0], old_entropy_tx["outputs_data"][0]
        )
        entropy_hash, _ = commit(fork, rebuilt)
        case.assertNotEqual(entropy_hash, old_entropy_hash)
        tip = fork.rpc("get_tip_header")
        case.assertGreater(int(tip["number"], 16), int(old_tip["number"], 16))
        case.assertLess(int(tip["number"], 16), 400)
        for block_height in range(fork_height + 1, int(tip["number"], 16) + 1):
            relay_block(case, fork, node, block_height)
        case.assertEqual(node.rpc("get_tip_header")["hash"], tip["hash"])
        case.assertNotEqual(
            node.rpc("get_block_hash", [seal_header["number"]]), seal_header["hash"]
        )
        old_cell = node.rpc(
            "get_live_cell", [{"tx_hash": old_entropy_hash, "index": "0x0"}, True]
        )
        case.assertIn(old_cell["status"], ("unknown", "dead"))
        new_cell = node.rpc(
            "get_live_cell", [{"tx_hash": entropy_hash, "index": "0x0"}, True]
        )
        case.assertEqual(new_cell["status"], "live")
        case.assertEqual(new_cell["cell"]["data"]["content"], exported["entropy"])
        # Identical probe except for the dependency: orphan rejects, canonical
        # commits. Sponsor output remains available for the continuing history.
        sponsor = copy.deepcopy(rebuilt["outputs"][1])
        sponsor["capacity"] = hex(int(sponsor["capacity"], 16) - 100_000)
        probe = {
            "version": "0x0",
            "cell_deps": protocol_deps
            + [
                {
                    "out_point": {"tx_hash": old_entropy_hash, "index": "0x0"},
                    "dep_type": "code",
                }
            ],
            "header_deps": [],
            "inputs": [input_cell(entropy_hash, 1)],
            "outputs": [sponsor],
            "outputs_data": ["0x"],
            "witnesses": ["0x"],
        }
        with case.assertRaisesRegex(RuntimeError, "Unknown|Dead|Resolve"):
            node.rpc("send_transaction", [probe, "passthrough"])
        probe["cell_deps"][-1]["out_point"]["tx_hash"] = entropy_hash
        sponsor_hash, _ = commit(node, probe)
        print(
            "DAOWOW entropy branch replaced and canonical dep recovered",
            old_entropy_hash,
            entropy_hash,
            "seal heights",
            int(seal_header["number"], 16),
            height,
            flush=True,
        )
        return (
            entropy_hash,
            rebuilt,
            exported,
            height,
            headers,
            input_cell(sponsor_hash, 0),
            sponsor,
        )
