"""Native DAO history on disposable nodes; no wallet or remote RPC support."""

import copy
import os
import unittest

from node_harness import IsolatedNode

CKB = 100_000_000
FEE = 100_000


def commit(node, transaction):
    tx_hash = node.rpc("send_transaction", [transaction, "passthrough"])
    for _ in range(20):
        node.rpc("generate_block")
        status = node.rpc("get_transaction", [tx_hash])["tx_status"]
        if status["status"] == "committed":
            return tx_hash, node.rpc("get_header", [status["block_hash"]])
    raise AssertionError(f"Transaction did not commit: {status}")


def input_cell(tx_hash, index, since=0):
    return {
        "since": hex(since),
        "previous_output": {"tx_hash": tx_hash, "index": hex(index)},
    }


@unittest.skipUnless(
    os.environ.get("DAOWOW_RUN_ISOLATED_NODE") == "1", "explicit Docker opt-in required"
)
class NativeDaoTests(unittest.TestCase):
    def test_native_dao_rejects_early_withdrawal_then_commits_at_maturity(self):
        with IsolatedNode() as node:
            genesis = node.rpc("get_block_by_number", ["0x0"])
            fixture_tx, fixture_index, fixture = next(
                (tx, i, output)
                for tx in genesis["transactions"]
                for i, output in enumerate(tx["outputs"])
                if output["lock"]["args"] == "0x64616f776f772d66697874757265"
            )
            code_tx, code_index = next(
                (tx, i)
                for tx in genesis["transactions"]
                for i, data in enumerate(tx["outputs_data"])
                if data == "0x" + node.fixture_code.hex()
            )
            # The pinned generated dev spec places native DAO at output two.
            dao_code = genesis["transactions"][0]
            self.assertIsNotNone(dao_code["outputs"][2]["type"])
            deps = [
                {
                    "out_point": {"tx_hash": code_tx["hash"], "index": hex(code_index)},
                    "dep_type": "code",
                },
                {
                    "out_point": {"tx_hash": dao_code["hash"], "index": "0x2"},
                    "dep_type": "code",
                },
            ]
            deposit = {
                "capacity": hex(10_000 * CKB),
                "lock": fixture["lock"],
                "type": {
                    "code_hash": node.rpc("get_consensus")["dao_type_hash"],
                    "hash_type": "type",
                    "args": "0x",
                },
            }
            change = {
                **fixture,
                "capacity": hex(int(fixture["capacity"], 16) - 10_000 * CKB - FEE),
            }
            transaction = {
                "version": "0x0",
                "cell_deps": deps,
                "header_deps": [],
                "inputs": [input_cell(fixture_tx["hash"], fixture_index)],
                "outputs": [deposit, change],
                "outputs_data": ["0x0000000000000000", "0x"],
                "witnesses": ["0x"],
            }
            deposit_hash, deposit_header = commit(node, transaction)
            self.assertGreater(int(deposit_header["number"], 16), 0)
            transaction = copy.deepcopy(transaction)
            transaction["inputs"] = [
                input_cell(deposit_hash, 0),
                input_cell(deposit_hash, 1),
            ]
            transaction["header_deps"] = [deposit_header["hash"]]
            transaction["outputs"][1]["capacity"] = hex(
                int(change["capacity"], 16) - FEE
            )
            transaction["outputs_data"][0] = (
                "0x" + int(deposit_header["number"], 16).to_bytes(8, "little").hex()
            )
            transaction["witnesses"] = ["0x", "0x"]
            withdrawal_hash, withdrawal_header = commit(node, transaction)
            self.assertGreater(
                int(withdrawal_header["number"], 16), int(deposit_header["number"], 16)
            )
            live = node.rpc(
                "get_live_cell", [{"tx_hash": withdrawal_hash, "index": "0x0"}, True]
            )
            self.assertEqual(live["status"], "live")
            self.assertEqual(
                live["cell"]["data"]["content"], transaction["outputs_data"][0]
            )
            self.assertEqual(live["cell"]["output"]["capacity"], hex(10_000 * CKB))
            # Both phases must be in the same epoch for this one-period fixture.
            deposit_epoch = int(deposit_header["epoch"], 16)
            withdrawal_epoch = int(withdrawal_header["epoch"], 16)
            self.assertEqual(deposit_epoch & 0xFFFFFF, withdrawal_epoch & 0xFFFFFF)
            self.assertNotEqual((deposit_epoch >> 24) & 0xFFFF, 0)
            maturity_epoch = deposit_epoch + 180
            since = 0x2000000000000000 | maturity_epoch
            deposit_ar = int.from_bytes(
                bytes.fromhex(deposit_header["dao"][2:])[8:16], "little"
            )
            withdrawal_ar = int.from_bytes(
                bytes.fromhex(withdrawal_header["dao"][2:])[8:16], "little"
            )
            # 8 capacity + (32+1+13) lock + (32+1) type + 8 data = 95 CKB.
            occupied = 95 * CKB
            maximum = occupied + (10_000 * CKB - occupied) * withdrawal_ar // deposit_ar
            self.assertGreater(maximum, 10_000 * CKB)
            final = {
                "version": "0x0",
                "cell_deps": deps,
                "header_deps": [deposit_header["hash"], withdrawal_header["hash"]],
                "inputs": [input_cell(withdrawal_hash, 0, since)],
                "outputs": [
                    {
                        "capacity": hex(maximum - FEE),
                        "lock": fixture["lock"],
                        "type": None,
                    }
                ],
                "outputs_data": ["0x"],
                # WitnessArgs: absent lock, input_type = Bytes(u64 header index 0), absent output_type.
                "witnesses": [
                    "0x1c00000010000000100000001c000000080000000000000000000000"
                ],
            }
            with self.assertRaisesRegex(RuntimeError, "Immature"):
                node.rpc("send_transaction", [final, "passthrough"])

            def fraction(epoch):
                return (epoch & 0xFFFFFF, (epoch >> 24) & 0xFFFF, epoch >> 40)

            target_number, target_index, target_length = fraction(maturity_epoch)
            checked_previous_fraction = False
            for height in range(2500):
                tip = node.rpc("get_tip_header")
                number, index, length = fraction(int(tip["epoch"], 16))
                if (
                    number == target_number
                    and index * target_length >= target_index * length
                ):
                    self.assertEqual(index * target_length, target_index * length)
                    break
                if (
                    number == target_number
                    and (index + 1) * target_length == target_index * length
                ):
                    with self.assertRaisesRegex(RuntimeError, "Immature"):
                        node.rpc("send_transaction", [final, "passthrough"])
                    checked_previous_fraction = True
                node.rpc("generate_block")
                if height % 300 == 0:
                    print(
                        "native DAO maturity mining",
                        height,
                        "epoch",
                        number,
                        flush=True,
                    )
            else:
                self.fail("Maturity boundary not reached within bounded mining budget")
            self.assertTrue(checked_previous_fraction)
            final_hash, final_header = commit(node, final)
            paid = node.rpc(
                "get_live_cell", [{"tx_hash": final_hash, "index": "0x0"}, True]
            )
            self.assertEqual(paid["status"], "live")
            self.assertEqual(paid["cell"]["output"]["capacity"], hex(maximum - FEE))
            self.assertIn(
                node.rpc(
                    "get_live_cell",
                    [{"tx_hash": withdrawal_hash, "index": "0x0"}, False],
                )["status"],
                ("dead", "unknown"),
            )
            committed = node.rpc("get_transaction", [final_hash])
            self.assertEqual(committed["tx_status"]["status"], "committed")
            self.assertEqual(committed["transaction"]["inputs"], final["inputs"])
            print(
                "native DAO matured payout",
                {
                    "deposit_epoch": deposit_header["epoch"],
                    "withdrawal_epoch": withdrawal_header["epoch"],
                    "boundary_tip": tip["epoch"],
                    "payout_block": final_header["number"],
                    "yield_shannons": maximum - 10_000 * CKB,
                },
                flush=True,
            )
