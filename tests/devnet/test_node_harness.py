"""Tests for disposable-node transport; live tests require explicit opt-in."""

import unittest
import os
import copy
import json
from pathlib import Path
import subprocess
from unittest.mock import patch

from node_harness import DockerError, IsolatedNode, decode_response, docker


class ResponseTests(unittest.TestCase):
    def test_decodes_content_length_and_chunked_rpc_responses(self):
        body = b'{"jsonrpc":"2.0","id":1,"result":"0x1"}'
        fixed = (
            b"HTTP/1.1 200 OK\r\nContent-Length: "
            + str(len(body)).encode()
            + b"\r\n\r\n"
            + body
        )
        chunked = (
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"
            + hex(len(body))[2:].encode()
            + b"\r\n"
            + body
            + b"\r\n0\r\n\r\n"
        )
        for wire in [fixed, chunked]:
            self.assertEqual(
                decode_response(wire), {"jsonrpc": "2.0", "id": 1, "result": "0x1"}
            )

    def test_rejects_http_error_instead_of_treating_it_as_rpc_success(self):
        with self.assertRaises(RuntimeError):
            decode_response(b"HTTP/1.1 503 Unavailable\r\nContent-Length: 2\r\n\r\n{}")


class LifecycleTests(unittest.TestCase):
    def test_launch_timeout_recovers_created_container_from_cidfile(self):
        identifier = "a" * 64
        running = set()

        def interrupted_docker(*args, **_kwargs):
            if args[0] == "run":
                running.add(identifier)
                if "--cidfile" in args:
                    Path(args[args.index("--cidfile") + 1]).write_text(identifier)
                raise subprocess.TimeoutExpired("docker run", 30)
            if args[:2] == ("rm", "-f"):
                running.remove(args[2])
                return b""
            self.fail(f"unexpected Docker operation: {args}")

        with patch("node_harness.docker", side_effect=interrupted_docker):
            with self.assertRaises(subprocess.TimeoutExpired):
                with IsolatedNode():
                    self.fail("launch should not complete")
        self.assertEqual(running, set(), "interrupted launch leaked a container")

    def test_already_removed_container_is_successful_cleanup(self):
        node = IsolatedNode()
        node.container_id = "a" * 64
        missing = DockerError(
            1,
            ["docker", "rm"],
            stderr=f"Error response from daemon: No such container: {node.container_id}\n".encode(),
        )
        with patch("node_harness.docker", side_effect=missing):
            error = None
            try:
                node.close()
            except DockerError as caught:
                error = caught
        self.assertIsNone(error)
        self.assertIsNone(node.container_id)


@unittest.skipUnless(
    os.environ.get("DAOWOW_RUN_ISOLATED_NODE") == "1", "explicit Docker opt-in required"
)
class LiveNodeTests(unittest.TestCase):
    def test_genesis_fixture_is_spendable_without_wallet_keys(self):
        with IsolatedNode() as node:
            genesis = node.rpc("get_block_by_number", ["0x0"])
            fixtures = [
                (tx, index, output)
                for tx in genesis["transactions"]
                for index, output in enumerate(tx["outputs"])
                if output["lock"]["args"] == "0x64616f776f772d66697874757265"
            ]
            self.assertEqual(len(fixtures), 1, "missing isolated spendable fixture")
            tx, index, output = fixtures[0]
            code = next(
                (parent, i)
                for parent in genesis["transactions"]
                for i, data in enumerate(parent["outputs_data"])
                if data == "0x" + node.fixture_code.hex()
            )
            spend = {
                "version": "0x0",
                "cell_deps": [
                    {
                        "out_point": {
                            "tx_hash": code[0]["hash"],
                            "index": hex(code[1]),
                        },
                        "dep_type": "code",
                    }
                ],
                "header_deps": [],
                "inputs": [
                    {
                        "since": "0x0",
                        "previous_output": {"tx_hash": tx["hash"], "index": hex(index)},
                    }
                ],
                "outputs": [
                    {**output, "capacity": hex(int(output["capacity"], 16) - 100_000)}
                ],
                "outputs_data": ["0x"],
                "witnesses": ["0x"],
            }
            transaction_hash = node.rpc("send_transaction", [spend, "passthrough"])
            for _ in range(12):
                node.rpc("generate_block")
                status = node.rpc("get_transaction", [transaction_hash])["tx_status"]
                if status["status"] == "committed":
                    break
            self.assertEqual(status["status"], "committed")

    def test_isolated_node_mines_with_target_cycle_limit(self):
        with IsolatedNode() as node:
            identifier = node.container_id
            inspected = json.loads(docker("inspect", identifier))[0]
            self.assertEqual(inspected["HostConfig"]["NetworkMode"], "none")
            self.assertTrue(inspected["HostConfig"]["ReadonlyRootfs"])
            self.assertFalse(inspected["HostConfig"]["Binds"])
            self.assertFalse(inspected["HostConfig"]["PortBindings"])
            self.assertEqual(node.rpc("get_blockchain_info")["chain"], "ckb_dev")
            consensus = node.rpc("get_consensus")
            self.assertEqual(int(consensus["max_block_cycles"], 16), 3_500_000_000)
            self.assertEqual(node.rpc("get_tip_block_number"), "0x0")
            block_hash = node.rpc("generate_block")
            self.assertEqual(node.rpc("get_tip_block_number"), "0x1")
            self.assertEqual(node.rpc("get_block_hash", ["0x1"]), block_hash)
            print("isolated node mined", block_hash, flush=True)
        with self.assertRaises(DockerError) as removed:
            docker("inspect", identifier)
        self.assertIn(b"no such", removed.exception.stderr.lower())

    def test_longer_competing_branch_reorganizes_canonical_chain(self):
        with IsolatedNode("first") as first, IsolatedNode("second") as second:
            genesis = first.rpc("get_block_hash", ["0x0"])
            self.assertEqual(genesis, second.rpc("get_block_hash", ["0x0"]))
            branch = []
            for _ in range(3):
                block_hash = first.rpc("generate_block")
                branch.append(first.rpc("get_block", [block_hash]))
            orphan = second.rpc("generate_block")
            self.assertNotEqual(branch[0]["header"]["hash"], orphan)
            self.assertEqual(second.rpc("get_block_hash", ["0x1"]), orphan)
            for block in branch:
                raw = copy.deepcopy(block)
                raw["header"].pop("hash")
                for tx in raw["transactions"]:
                    tx.pop("hash")
                self.assertEqual(
                    second.rpc("submit_block", ["0x0", raw]), block["header"]["hash"]
                )
            self.assertEqual(
                second.rpc("get_tip_header")["hash"], branch[-1]["header"]["hash"]
            )
            self.assertEqual(
                second.rpc("get_block_hash", ["0x1"]), branch[0]["header"]["hash"]
            )
            print(
                "actual competing-branch reorg",
                {
                    "genesis": genesis,
                    "orphan": orphan,
                    "canonical_tip": branch[-1]["header"]["hash"],
                },
                flush=True,
            )


if __name__ == "__main__":
    unittest.main()
