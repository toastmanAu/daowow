"""Actual DAOWOW creation, using Rust-exported canonical protocol bytes."""

import copy
import json
import os
from pathlib import Path
import subprocess
import unittest

import js_settlement
from node_harness import IsolatedNode
from reorg_history import replace_entropy_branch
from refund_history import refund_excluded_entry
from retirement_history import retire_sealed_round
from settlement_reorg import recover_settlement_history
from test_native_dao import CKB, commit, input_cell

ROOT = Path(__file__).resolve().parents[2]


def epoch_parts(epoch):
    return epoch & 0xFFFFFF, (epoch >> 24) & 0xFFFF, (epoch >> 40) & 0xFFFF


def mine_to_epoch(node, target):
    number, index, length = epoch_parts(target)
    for mined in range(4000):
        tip = node.rpc("get_tip_header")
        n, i, size = epoch_parts(int(tip["epoch"], 16))
        if n > number or (n == number and i * length >= index * size):
            return tip
        node.rpc("generate_block")
        if mined % 300 == 0:
            print(
                "DAOWOW maturity mining",
                mined,
                "epoch",
                n,
                "target",
                number,
                flush=True,
            )
    raise AssertionError("DAO maturity not reached within bounded mining budget")


@unittest.skipUnless(
    os.environ.get("DAOWOW_RUN_ISOLATED_NODE") == "1", "explicit Docker opt-in required"
)
class RoundCreationTests(unittest.TestCase):
    # Populated by every run_history() invocation that reaches the DAO
    # deposit (all but the two refund-only histories) / the maturity
    # section (only the histories that carry a batch all the way to
    # settlement). Asserted in tearDownClass across the whole suite: the
    # requirement is that every deposit in the round starts within a
    # bounded window and every batch finishes (matures) at the same
    # boundary, which is a property of the *fleet* of batches this test
    # class produces, not any single one of them.
    deposit_epoch_numbers = []
    maturity_deltas = []
    window_width = None

    @classmethod
    def tearDownClass(cls):
        if cls.deposit_epoch_numbers:
            spread = max(cls.deposit_epoch_numbers) - min(cls.deposit_epoch_numbers)
            print(
                "DAOWOW deposit epoch numbers across",
                len(cls.deposit_epoch_numbers),
                "batches:",
                cls.deposit_epoch_numbers,
                "spread",
                spread,
                "configured window width",
                cls.window_width,
                flush=True,
            )
            assert cls.window_width is not None
            assert spread <= cls.window_width, (
                f"deposit epoch spread {spread} exceeded the configured "
                f"window width {cls.window_width}"
            )
        if cls.maturity_deltas:
            print(
                "DAOWOW maturity deltas (epochs past deposit) across",
                len(cls.maturity_deltas),
                "batches:",
                cls.maturity_deltas,
                flush=True,
            )
            assert set(cls.maturity_deltas) == {360}, (
                "every batch must mature at the same D+360 boundary, got "
                f"{cls.maturity_deltas}"
            )

    def test_creation_entry_freeze_and_aggregation_history(self):
        self.run_history(reorg=False)

    def test_orphaned_entropy_rebuild_and_payout(self):
        self.run_history(reorg=True)

    def test_excluded_entry_refund_after_deadline(self):
        self.run_history(reorg=False, refund=True)

    def test_orphaned_funding_and_payout_recovery(self):
        self.run_history(reorg=False, recover=True)

    def test_orphaned_refund_recovery(self):
        self.run_history(reorg=True, refund=True)

    def test_partial_acceptance_refunds_only_excluded_entry(self):
        self.run_history(reorg=False, partial=True)

    def test_partial_round_completes_payout(self):
        self.run_history(reorg=False, partial=True, partial_full=True)

    def test_sealed_round_retires_to_completion(self):
        self.run_history(reorg=False, partial=True, partial_full=True, retire=True)

    def run_history(
        self,
        *,
        reorg,
        refund=False,
        recover=False,
        partial=False,
        partial_full=False,
        retire=False,
        js=False,
    ):
        with IsolatedNode(daowow=True) as node:
            genesis = node.rpc("get_block_by_number", ["0x0"])
            fixture_tx, index, fixture = next(
                (tx, i, output)
                for tx in genesis["transactions"]
                for i, output in enumerate(tx["outputs"])
                if output["lock"]["args"] == "0x64616f776f772d66697874757265"
            )
            exported = json.loads(
                subprocess.run(
                    [
                        str(ROOT / "target/debug/examples/devnet_round"),
                        fixture_tx["hash"],
                        str(index),
                        node.rpc("get_consensus")["dao_type_hash"],
                        *(["partial"] if partial else []),
                    ],
                    cwd=ROOT,
                    check=True,
                    capture_output=True,
                    timeout=30,
                ).stdout
            )
            self.assertEqual(len(exported["shards"]), 2)
            if partial:
                self.assertTrue(exported["partial"])
            code_bytes = [node.fixture_code, *node.protocol_codes.values()]
            deps = [
                {
                    "out_point": {"tx_hash": tx["hash"], "index": hex(i)},
                    "dep_type": "code",
                }
                for tx in genesis["transactions"]
                for i, data in enumerate(tx["outputs_data"])
                if any(data == "0x" + code.hex() for code in code_bytes)
            ]
            self.assertEqual(len(deps), 6)
            outputs = [
                {
                    "capacity": hex(600 * CKB),
                    "lock": fixture["lock"],
                    "type": exported["round_type"],
                }
            ]
            data = [exported["config"]]
            for shard in exported["shards"]:
                outputs.append(
                    {
                        "capacity": hex(400 * CKB),
                        "lock": exported["public_lock"],
                        "type": shard["type"],
                    }
                )
                data.append(shard["data"])
            outputs.append(
                {
                    **fixture,
                    "capacity": hex(
                        int(fixture["capacity"], 16) - 1400 * CKB - 100_000
                    ),
                }
            )
            data.append("0x")
            tx = {
                "version": "0x0",
                "cell_deps": deps,
                "header_deps": [],
                "inputs": [input_cell(fixture_tx["hash"], index)],
                "outputs": outputs,
                "outputs_data": data,
                "witnesses": [exported["witness"]],
            }
            invalid = copy.deepcopy(tx)
            invalid["outputs"].pop(2)
            invalid["outputs_data"].pop(2)
            invalid["outputs"][-1]["capacity"] = hex(
                int(outputs[-1]["capacity"], 16) + 400 * CKB
            )
            with self.assertRaisesRegex(RuntimeError, "ValidationFailure"):
                node.rpc("send_transaction", [invalid, "passthrough"])
            missing_schedule = copy.deepcopy(tx)
            missing_schedule["witnesses"] = ["0x"]
            with self.assertRaisesRegex(RuntimeError, "ValidationFailure"):
                node.rpc("send_transaction", [missing_schedule, "passthrough"])
            tx_hash, header = commit(node, tx)
            # The web client finds rounds through the INDEXER, not by knowing
            # an out point, so that path is exercised here against a real
            # round rather than against a mock. It needs the Indexer rpc
            # module, which the pinned image does not enable by default (see
            # node_harness). The captured cell is also the fixture
            # apps/web/test/discovery.test.js decodes, so the JavaScript
            # decoder is pinned to a round this suite actually created.
            found = node.rpc(
                "get_cells",
                [
                    {
                        "script": exported["round_type"],
                        "script_type": "type",
                        "script_search_mode": "prefix",
                        "with_data": True,
                    },
                    "asc",
                    "0xa",
                    None,
                ],
            )
            live_rounds = [
                o
                for o in found["objects"]
                if len(o["output_data"]) == 2 + 358 * 2
            ]
            self.assertEqual(
                len(live_rounds), 1, "the indexer must return exactly this round"
            )
            self.assertEqual(live_rounds[0]["out_point"]["tx_hash"], tx_hash)
            # NOT named `fixture`: that name is already the genesis fixture
            # cell in this function and shadowing it breaks every later
            # fixture["lock"] read.
            round_fixture_path = (
                ROOT / "apps" / "web" / "test" / "fixtures" / "devnet-round-cell.json"
            )
            round_fixture_path.write_text(
                json.dumps(live_rounds[0], indent=2, sort_keys=True)
            )
            print(
                "DAOWOW round discovered through the indexer",
                tx_hash,
                "data bytes",
                (len(live_rounds[0]["output_data"]) - 2) // 2,
                flush=True,
            )
            for i in range(3):
                live = node.rpc(
                    "get_live_cell", [{"tx_hash": tx_hash, "index": hex(i)}, True]
                )
                self.assertEqual(live["status"], "live")
                self.assertEqual(live["cell"]["output"], outputs[i])
                self.assertEqual(live["cell"]["data"]["content"], data[i])
            print(
                "DAOWOW round and two shards committed",
                tx_hash,
                header["number"],
                flush=True,
            )
            self.assertIn(
                "append", exported, "missing canonical entry transition fixture"
            )
            append = exported["append"]
            window = exported["window"]
            self.assertGreater(
                window["entry_start"], 0, "entry_start must be non-zero for the opening check to run"
            )
            # The opening check (entry-shard-type) only fires when entry_start
            # is non-zero, and it reads its bound from the shard input's own
            # `since` field, not the block the append lands in — but CKB
            # consensus itself will refuse to include a tx whose absolute-
            # epoch `since` names an epoch the tip hasn't reached yet. Mine to
            # entry_start for real before submitting the append, rather than
            # asserting a since value the chain could never have honoured.
            for _ in range(30):
                if int(node.rpc("get_tip_header")["epoch"], 16) & 0xFFFFFF >= window[
                    "entry_start"
                ]:
                    break
                node.rpc("generate_block")
            else:
                self.fail(
                    "entry_start epoch not reached before the first append; "
                    "devnet cannot exercise the opening check"
                )
            protocol_deps = deps + [
                {"out_point": {"tx_hash": tx_hash, "index": "0x0"}, "dep_type": "code"}
            ]
            change = {
                **outputs[-1],
                "capacity": hex(int(outputs[-1]["capacity"], 16) - 400 * CKB - 100_000),
            }
            entry_tx = {
                "version": "0x0",
                "cell_deps": protocol_deps,
                "header_deps": [],
                "inputs": [
                    input_cell(tx_hash, 1, int(append["since"], 16)),
                    input_cell(tx_hash, 3),
                ],
                "outputs": [
                    outputs[1],
                    {
                        "capacity": hex(400 * CKB),
                        "lock": append["entry_lock"],
                        "type": None,
                    },
                    change,
                ],
                "outputs_data": [append["shard_data"], append["entry_data"], "0x"],
                "witnesses": [append["witness"], "0x"],
            }
            if partial:
                entry_tx["outputs"].append(copy.deepcopy(entry_tx["outputs"][1]))
                entry_tx["outputs_data"].append(append["excluded_data"])
                change["capacity"] = hex(int(change["capacity"], 16) - 400 * CKB)
            # one claim NFT per ticket, appended after the change (index 2) and
            # the excluded entry (index 3) so later steps keep their indexes;
            # the change output pays for them
            for claim in append["claims"]:
                entry_tx["outputs"].append(
                    {"capacity": claim["capacity"], "lock": claim["lock"], "type": claim["type"]}
                )
                entry_tx["outputs_data"].append(claim["data"])
                change["capacity"] = hex(
                    int(change["capacity"], 16) - int(claim["capacity"], 16)
                )
            corrupt = copy.deepcopy(entry_tx)
            corrupt["outputs_data"][0] = corrupt["outputs_data"][0][:-2] + (
                "00" if corrupt["outputs_data"][0][-2:] != "00" else "01"
            )
            with self.assertRaisesRegex(RuntimeError, "ValidationFailure"):
                node.rpc("send_transaction", [corrupt, "passthrough"])
            entry_hash, _ = commit(node, entry_tx)
            for i in (0, 1):
                live = node.rpc(
                    "get_live_cell", [{"tx_hash": entry_hash, "index": hex(i)}, True]
                )
                self.assertEqual(live["status"], "live")
                self.assertEqual(
                    live["cell"]["data"]["content"], entry_tx["outputs_data"][i]
                )
            freeze = exported["freeze"]
            freeze_tx = {
                "version": "0x0",
                "cell_deps": protocol_deps,
                "header_deps": [],
                "inputs": [
                    input_cell(entry_hash, 0, int(freeze["since"], 16)),
                    input_cell(tx_hash, 2, int(freeze["since"], 16)),
                    input_cell(entry_hash, 2),
                ],
                "outputs": [
                    outputs[1],
                    outputs[2],
                    {**change, "capacity": hex(int(change["capacity"], 16) - 100_000)},
                ],
                "outputs_data": [*freeze["shard_data"], "0x"],
                "witnesses": ["0x", "0x", "0x"],
            }
            with self.assertRaisesRegex(RuntimeError, "Immature"):
                node.rpc("send_transaction", [freeze_tx, "passthrough"])
            for _ in range(30):
                if int(node.rpc("get_tip_header")["epoch"], 16) & 0xFFFFFF >= 2:
                    break
                node.rpc("generate_block")
            else:
                self.fail("entry-end epoch not reached")
            frozen_hash, frozen_header = commit(node, freeze_tx)
            for i in (0, 1):
                live = node.rpc(
                    "get_live_cell", [{"tx_hash": frozen_hash, "index": hex(i)}, True]
                )
                self.assertEqual(live["status"], "live")
                self.assertEqual(
                    live["cell"]["data"]["content"], freeze["shard_data"][i]
                )
            print(
                "DAOWOW entry appended and both shards frozen",
                entry_hash,
                frozen_hash,
                frozen_header["number"],
                flush=True,
            )
            self.assertIn(
                "aggregation", exported, "missing canonical aggregation fixture"
            )
            aggregation = exported["aggregation"]
            init_change = {
                **freeze_tx["outputs"][-1],
                "capacity": hex(
                    int(freeze_tx["outputs"][-1]["capacity"], 16) - 100_000
                ),
            }
            init = {
                "version": "0x0",
                "cell_deps": protocol_deps,
                "header_deps": [],
                "inputs": [input_cell(frozen_hash, 0), input_cell(frozen_hash, 2)],
                "outputs": [outputs[1], init_change],
                "outputs_data": [aggregation["initial_ledger"], "0x"],
                "witnesses": ["0x", "0x"],
            }
            ledger_hash, _ = commit(node, init)
            if refund:
                self.assertIn("refund", exported, "missing canonical refund fixture")
                refund_excluded_entry(
                    self,
                    node,
                    exported["refund"],
                    protocol_deps,
                    init,
                    ledger_hash,
                    entry_hash,
                    fixture["lock"],
                    reorg=reorg,
                )
                return
            native_dao_dep = {
                "out_point": {
                    "tx_hash": genesis["transactions"][0]["hash"],
                    "index": "0x2",
                },
                "dep_type": "code",
            }
            aggregate = {
                "version": "0x0",
                "cell_deps": protocol_deps + [native_dao_dep],
                "header_deps": [],
                "inputs": [
                    input_cell(ledger_hash, 0),
                    input_cell(entry_hash, 1),
                    input_cell(ledger_hash, 1),
                ],
                "outputs": [
                    outputs[1],
                    {
                        "capacity": hex(400 * CKB),
                        "lock": aggregation["dao_lock"],
                        "type": {
                            "code_hash": node.rpc("get_consensus")["dao_type_hash"],
                            "hash_type": "type",
                            "args": "0x",
                        },
                    },
                    {
                        "capacity": hex(400 * CKB),
                        "lock": exported["public_lock"],
                        "type": aggregation["receipt_type"],
                    },
                    {
                        **init_change,
                        "capacity": hex(
                            int(init_change["capacity"], 16) - 400 * CKB - 100_000
                        ),
                    },
                ],
                "outputs_data": [
                    aggregation["next_ledger"],
                    "0x0000000000000000",
                    aggregation["receipt_data"],
                    "0x",
                ],
                "witnesses": [aggregation["witness"], "0x", "0x"],
            }
            wrong_amount = copy.deepcopy(aggregate)
            wrong_amount["outputs"][1]["capacity"] = hex(400 * CKB - 1)
            wrong_amount["outputs"][-1]["capacity"] = hex(
                int(aggregate["outputs"][-1]["capacity"], 16) + 1
            )
            with self.assertRaisesRegex(RuntimeError, "ValidationFailure"):
                node.rpc("send_transaction", [wrong_amount, "passthrough"])
            aggregate_hash, aggregate_header = commit(node, aggregate)
            for i in range(3):
                live = node.rpc(
                    "get_live_cell",
                    [{"tx_hash": aggregate_hash, "index": hex(i)}, True],
                )
                self.assertEqual(live["status"], "live")
                self.assertEqual(live["cell"]["output"], aggregate["outputs"][i])
                self.assertEqual(
                    live["cell"]["data"]["content"], aggregate["outputs_data"][i]
                )
            print(
                "DAOWOW ledger, full-capacity DAO deposit and receipt committed",
                aggregate_hash,
                aggregate_header["number"],
                flush=True,
            )
            # The requirement: every deposit starts inside a bounded window.
            # `close()` only forces `since >= aggregation_deadline` when
            # aggregation is *incomplete*; a complete round can close as soon
            # as `entry_end`. So the window is a property this harness must
            # observe on the real chain, not one the protocol enforces on the
            # deposit itself — assert it rather than assume it.
            deposit_epoch_number = int(aggregate_header["epoch"], 16) & 0xFFFFFF
            self.assertGreaterEqual(deposit_epoch_number, window["entry_end"])
            self.assertLessEqual(deposit_epoch_number, window["aggregation_deadline"])
            type(self).deposit_epoch_numbers.append(deposit_epoch_number)
            type(self).window_width = (
                window["aggregation_deadline"] - window["entry_end"]
            )
            if partial:
                accepted = node.rpc(
                    "get_live_cell", [{"tx_hash": entry_hash, "index": "0x1"}, True]
                )
                self.assertIn(accepted["status"], ("dead", "unknown"))
                partial_refund = refund_excluded_entry(
                    self,
                    node,
                    exported["refund"],
                    protocol_deps,
                    {"outputs": [aggregate["outputs"][0], aggregate["outputs"][3]]},
                    aggregate_hash,
                    entry_hash,
                    fixture["lock"],
                    entry_index=3,
                    sponsor_index=3,
                )
                for i in (1, 2):
                    live = node.rpc(
                        "get_live_cell",
                        [{"tx_hash": aggregate_hash, "index": hex(i)}, True],
                    )
                    self.assertEqual(live["status"], "live")
                    self.assertEqual(live["cell"]["output"], aggregate["outputs"][i])
                    self.assertEqual(
                        live["cell"]["data"]["content"], aggregate["outputs_data"][i]
                    )
                print(
                    "DAOWOW partial acceptance preserved DAO and receipt while excluded entry refunded",
                    aggregate_hash,
                    flush=True,
                )
                if not partial_full:
                    return
            self.assertIn("seal", exported, "missing closed-universe seal fixture")
            seal = exported["seal"]
            continuing_sponsor = (
                partial_refund["transaction"]["outputs"][1]
                if partial
                else aggregate["outputs"][-1]
            )
            continuing_input = (
                input_cell(partial_refund["refund_hash"], 1)
                if partial
                else input_cell(aggregate_hash, 3)
            )
            sponsor = {
                **continuing_sponsor,
                "capacity": hex(int(continuing_sponsor["capacity"], 16) - 100_000),
            }
            empty_init = {
                "version": "0x0",
                "cell_deps": protocol_deps,
                "header_deps": [],
                "inputs": [input_cell(frozen_hash, 1), continuing_input],
                "outputs": [outputs[2], sponsor],
                "outputs_data": [seal["empty_ledger"], "0x"],
                "witnesses": ["0x", "0x"],
            }
            empty_hash, _ = commit(node, empty_init)
            sponsor = {
                **sponsor,
                "capacity": hex(int(sponsor["capacity"], 16) - 100_000),
            }
            close = {
                "version": "0x0",
                "cell_deps": protocol_deps,
                "header_deps": [],
                "inputs": [
                    input_cell(aggregate_hash, 0, int(freeze["since"], 16)),
                    input_cell(empty_hash, 0, int(freeze["since"], 16)),
                    input_cell(empty_hash, 1),
                ],
                "outputs": [outputs[1], outputs[2], sponsor],
                "outputs_data": [*seal["closed"], "0x"],
                "witnesses": ["0x", "0x", "0x"],
            }
            if partial:
                # Shard zero was already closed to authorize the refund.
                close["inputs"].pop(0)
                close["outputs"].pop(0)
                close["outputs_data"].pop(0)
                close["witnesses"].pop(0)
            close_hash, _ = commit(node, close)
            sponsor = {
                **sponsor,
                "capacity": hex(int(sponsor["capacity"], 16) - 400 * CKB - 100_000),
            }
            seal_cell = {**outputs[1], "capacity": hex(800 * CKB)}
            seal_tx = {
                "version": "0x0",
                "cell_deps": protocol_deps
                + [
                    {
                        "out_point": {"tx_hash": close_hash, "index": "0x1"},
                        "dep_type": "code",
                    }
                ],
                "header_deps": [],
                "inputs": [input_cell(close_hash, 0), input_cell(close_hash, 2)],
                "outputs": [seal_cell, sponsor],
                "outputs_data": [seal["data"], "0x"],
                "witnesses": ["0x", "0x"],
            }
            if partial:
                seal_tx["cell_deps"][-1]["out_point"]["index"] = "0x0"
                seal_tx["inputs"] = [
                    input_cell(partial_refund["closed_hash"], 0),
                    input_cell(close_hash, 1),
                ]
            missing_shard = copy.deepcopy(seal_tx)
            missing_shard["cell_deps"].pop()
            with self.assertRaisesRegex(RuntimeError, "ValidationFailure"):
                node.rpc("send_transaction", [missing_shard, "passthrough"])
            seal_hash, seal_header = commit(node, seal_tx)
            live = node.rpc(
                "get_live_cell", [{"tx_hash": seal_hash, "index": "0x0"}, True]
            )
            self.assertEqual(live["status"], "live")
            self.assertEqual(live["cell"]["data"]["content"], seal["data"])
            print(
                "DAOWOW closed-universe seal committed",
                seal_hash,
                seal_header["number"],
                flush=True,
            )
            self.assertIn("entropy", exported, "missing scheduled entropy export")
            seal_height = int(seal_header["number"], 16)
            # Use the actual committed seal anchor, not its submission height.
            for _ in range(192):
                node.rpc("generate_block")
            headers = [seal_header["hash"]] + [
                node.rpc("get_block_hash", [hex(seal_height + offset)])
                for offset in (64, 128, 192)
            ]
            entropy_export = json.loads(
                subprocess.run(
                    [
                        str(ROOT / "target/debug/examples/devnet_round"),
                        fixture_tx["hash"],
                        str(index),
                        node.rpc("get_consensus")["dao_type_hash"],
                        str(seal_height),
                        *headers,
                        *(["partial"] if partial else []),
                    ],
                    cwd=ROOT,
                    check=True,
                    capture_output=True,
                    timeout=30,
                ).stdout
            )
            self.assertEqual(entropy_export["seal"], seal)
            self.assertIsInstance(entropy_export["entropy"], str)
            entropy_tx = {
                "version": "0x0",
                "cell_deps": protocol_deps,
                "header_deps": headers,
                "inputs": [
                    input_cell(seal_hash, 0, 0x8000000000000100),
                    input_cell(seal_hash, 1),
                ],
                "outputs": [
                    seal_cell,
                    {
                        **sponsor,
                        "capacity": hex(int(sponsor["capacity"], 16) - 100_000),
                    },
                ],
                "outputs_data": [entropy_export["entropy"], "0x"],
                "witnesses": ["0x", "0x"],
            }
            with self.assertRaisesRegex(RuntimeError, "Immature"):
                node.rpc("send_transaction", [entropy_tx, "passthrough"])
            # Pool admission can anticipate maturity through its proposal
            # window. Check block inclusion, not an assumed pool cutoff.
            for _ in range(64):
                node.rpc("generate_block")
            self.assertEqual(
                int(node.rpc("get_tip_block_number"), 16), seal_height + 256
            )
            wrong_header = copy.deepcopy(entropy_tx)
            wrong_header["header_deps"][1] = node.rpc(
                "get_block_hash", [hex(seal_height + 63)]
            )
            with self.assertRaisesRegex(RuntimeError, "ValidationFailure"):
                node.rpc("send_transaction", [wrong_header, "passthrough"])
            forged = copy.deepcopy(entropy_tx)
            forged["outputs_data"][0] = forged["outputs_data"][0][:-2] + (
                "00" if forged["outputs_data"][0][-2:] != "00" else "01"
            )
            with self.assertRaisesRegex(RuntimeError, "ValidationFailure"):
                node.rpc("send_transaction", [forged, "passthrough"])
            entropy_hash, entropy_header = commit(node, entropy_tx)
            self.assertGreaterEqual(
                int(entropy_header["number"], 16), seal_height + 256
            )
            live = node.rpc(
                "get_live_cell", [{"tx_hash": entropy_hash, "index": "0x0"}, True]
            )
            self.assertEqual(live["status"], "live")
            self.assertEqual(live["cell"]["output"], seal_cell)
            self.assertEqual(live["cell"]["data"]["content"], entropy_export["entropy"])
            print(
                "DAOWOW authenticated scheduled entropy committed",
                entropy_hash,
                entropy_header["number"],
                "seal height",
                seal_height,
                flush=True,
            )
            self.assertIn(
                "settlement", entropy_export, "missing computed settlement fixture"
            )
            sponsor_input = input_cell(entropy_hash, 1)
            if reorg:
                (
                    entropy_hash,
                    entropy_tx,
                    entropy_export,
                    seal_height,
                    headers,
                    sponsor_input,
                    sponsor_cell,
                ) = replace_entropy_branch(
                    self,
                    node,
                    seal_tx,
                    seal_header,
                    entropy_tx,
                    entropy_hash,
                    [
                        str(ROOT / "target/debug/examples/devnet_round"),
                        fixture_tx["hash"],
                        str(index),
                        node.rpc("get_consensus")["dao_type_hash"],
                    ],
                    ROOT,
                    protocol_deps,
                )
                entropy_tx["outputs"][1] = sponsor_cell
            deposit_epoch = int(aggregate_header["epoch"], 16)
            # dao-lock only requires since >= deposit_epoch + 180 (one term),
            # but RFC 0023 native DAO maturity then snaps to the *next*
            # 180-epoch boundary from the deposit: preparing phase one exactly
            # at D+180 matures at D+180, while D+181 (or anywhere up to
            # D+359) matures at D+360, deterministically, regardless of the
            # deposit's epoch fraction. Target D+181 — strictly inside
            # (D+180, D+360) — so every batch lands on the same D+360
            # boundary instead of racing a fraction-precision knife edge.
            term_epoch = deposit_epoch + 181
            term_since = 0x2000000000000000 | term_epoch
            receipt_dep = {
                "out_point": {"tx_hash": aggregate_hash, "index": "0x2"},
                "dep_type": "code",
            }
            dao_deps = protocol_deps + [native_dao_dep, receipt_dep]
            withdrawing_data = (
                "0x" + int(aggregate_header["number"], 16).to_bytes(8, "little").hex()
            )
            withdrawal = {
                "version": "0x0",
                "cell_deps": dao_deps,
                "header_deps": [aggregate_header["hash"]],
                "inputs": [
                    input_cell(aggregate_hash, 1, term_since),
                    sponsor_input,
                ],
                "outputs": [
                    aggregate["outputs"][1],
                    {
                        **entropy_tx["outputs"][1],
                        "capacity": hex(
                            int(entropy_tx["outputs"][1]["capacity"], 16) - 100_000
                        ),
                    },
                ],
                "outputs_data": [withdrawing_data, "0x"],
                "witnesses": ["0x", "0x"],
            }
            short_term = copy.deepcopy(withdrawal)
            short_term["inputs"][0]["since"] = "0x0"
            with self.assertRaisesRegex(RuntimeError, "ValidationFailure"):
                node.rpc("send_transaction", [short_term, "passthrough"])
            with self.assertRaisesRegex(RuntimeError, "Immature"):
                node.rpc("send_transaction", [withdrawal, "passthrough"])
            mine_to_epoch(node, term_epoch)
            missing_receipt = copy.deepcopy(withdrawal)
            missing_receipt["cell_deps"].pop()
            with self.assertRaisesRegex(RuntimeError, "ValidationFailure"):
                node.rpc("send_transaction", [missing_receipt, "passthrough"])
            if js:
                # The same transaction from the JavaScript builder. Where the
                # two must agree they are compared; then the JavaScript one is
                # what the node is asked to take.
                js_common = {
                    "config": exported["config"],
                    "scripts": js_settlement.script_points(node, genesis),
                    "config_out_point": {"tx_hash": tx_hash, "index": "0x0"},
                    "dao_type_dep": native_dao_dep,
                    "dao_type": aggregate["outputs"][1]["type"],
                }
                js_lock_dep = js_settlement.fixture_lock_dep(node, genesis)
                js_deposit = {
                    key: aggregate["outputs"][1][key]
                    for key in ("capacity", "lock", "type")
                }
                answer = js_settlement.built(
                    self,
                    "dao-phase-one",
                    **js_common,
                    sponsor=js_settlement.sponsor_of(
                        sponsor_input["previous_output"],
                        entropy_tx["outputs"][1],
                        js_lock_dep,
                    ),
                    deposits=[
                        {
                            "out_point": {"tx_hash": aggregate_hash, "index": "0x1"},
                            "receipt_out_point": receipt_dep["out_point"],
                            **js_deposit,
                        }
                    ],
                    deposit_headers=[aggregate_header],
                )
                js_tx = answer["tx"]
                self.assertEqual(js_tx["outputs"][0], withdrawal["outputs"][0])
                self.assertEqual(js_tx["outputs_data"][0], withdrawal["outputs_data"][0])
                self.assertEqual(js_tx["header_deps"], withdrawal["header_deps"])
                self.assertEqual(
                    js_tx["inputs"][0]["previous_output"],
                    withdrawal["inputs"][0]["previous_output"],
                )
                # The builder names the same epoch with no fraction.
                self.assertEqual(
                    int(js_tx["inputs"][0]["since"], 16),
                    0x2000000000000000 | ((deposit_epoch & 0xFFFFFF) + 181),
                )
                self.assertEqual(
                    answer["maturity_epochs"], [str((deposit_epoch & 0xFFFFFF) + 360)]
                )
                withdrawal = js_tx
                print("DAOWOW JS builder: phase one built and matched", flush=True)
            withdrawal_hash, withdrawal_header = commit(node, withdrawal)
            print(
                "DAOWOW withdrawal preparation committed",
                withdrawal_hash,
                withdrawal_header["epoch"],
                flush=True,
            )
            live = node.rpc(
                "get_live_cell", [{"tx_hash": withdrawal_hash, "index": "0x0"}, True]
            )
            self.assertEqual(live["cell"]["output"], aggregate["outputs"][1])
            self.assertEqual(live["cell"]["data"]["content"], withdrawing_data)
            dn, di, dl = epoch_parts(deposit_epoch)
            wn, wi, wl = epoch_parts(int(withdrawal_header["epoch"], 16))
            elapsed = wn - dn + int(wi * dl > di * wl)
            periods = (elapsed + 179) // 180
            final_epoch = (deposit_epoch & ~0xFFFFFF) | (dn + periods * 180)
            # The property under test: targeting phase one strictly inside
            # (D+180, D+360) — never exactly at D+180 — makes maturity land
            # on the SAME boundary (D+360) for every batch, deterministically,
            # regardless of where within that span the withdrawal actually
            # landed (mining and tx-commit timing vary run to run). final_epoch
            # and deposit_epoch share the same index/length (fraction) bits by
            # construction, so their raw difference is exactly periods * 180.
            maturity_delta = final_epoch - deposit_epoch
            self.assertEqual(
                maturity_delta,
                360,
                "phase one landed on the D+180 knife edge instead of "
                "strictly inside (D+180, D+360)",
            )
            type(self).maturity_deltas.append(maturity_delta)
            # Actual occupied capacity: 8 + (32+1+104) + (32+1) + 8 = 186 CKB.
            deposit_ar = int.from_bytes(
                bytes.fromhex(aggregate_header["dao"][2:])[8:16], "little"
            )
            withdraw_ar = int.from_bytes(
                bytes.fromhex(withdrawal_header["dao"][2:])[8:16], "little"
            )
            realized = 186 * CKB + (400 - 186) * CKB * withdraw_ar // deposit_ar
            funding_export = json.loads(
                subprocess.run(
                    [
                        str(ROOT / "target/debug/examples/devnet_round"),
                        fixture_tx["hash"],
                        str(index),
                        node.rpc("get_consensus")["dao_type_hash"],
                        str(seal_height),
                        *headers,
                        str(realized),
                        *(["partial"] if partial else []),
                    ],
                    cwd=ROOT,
                    check=True,
                    capture_output=True,
                    timeout=30,
                ).stdout
            )
            self.assertEqual(funding_export["entropy"], entropy_export["entropy"])
            settlement = funding_export["settlement"]
            self.assertEqual(settlement["principal"], 400 * CKB)
            # prizes are owed to tickets, not to the depositor's payout
            self.assertEqual(settlement["prize"], 0)
            self.assertEqual(settlement["prize_pool"], realized - 400 * CKB)
            self.assertGreater(settlement["prize_pool"], 0)
            funding_tx = {
                "version": "0x0",
                "cell_deps": dao_deps
                + [
                    {
                        "out_point": {"tx_hash": entropy_hash, "index": "0x0"},
                        "dep_type": "code",
                    }
                ],
                "header_deps": [aggregate_header["hash"], withdrawal_header["hash"]],
                "inputs": [
                    input_cell(withdrawal_hash, 0, 0x2000000000000000 | final_epoch),
                    input_cell(withdrawal_hash, 1),
                ],
                "outputs": [
                    {
                        "capacity": hex(realized),
                        "lock": settlement["lock"],
                        "type": settlement["type"],
                    },
                    {
                        **withdrawal["outputs"][1],
                        "capacity": hex(
                            int(withdrawal["outputs"][1]["capacity"], 16) - 100_000
                        ),
                    },
                ],
                "outputs_data": [settlement["data"], "0x"],
                "witnesses": [settlement["witness"], "0x"],
            }
            with self.assertRaisesRegex(RuntimeError, "Immature"):
                node.rpc("send_transaction", [funding_tx, "passthrough"])
            mine_to_epoch(node, final_epoch)
            forged_funding = copy.deepcopy(funding_tx)
            forged_funding["outputs_data"][0] = forged_funding["outputs_data"][0][
                :-2
            ] + ("00" if forged_funding["outputs_data"][0][-2:] != "00" else "01")
            with self.assertRaisesRegex(RuntimeError, "ValidationFailure"):
                node.rpc("send_transaction", [forged_funding, "passthrough"])
            if js:
                js_evidence = {
                    "creation_witness": exported["witness"],
                    "aggregate_inputs": js_settlement.spent_cells(node, aggregate),
                    "record": node.rpc(
                        "get_live_cell",
                        [{"tx_hash": entropy_hash, "index": "0x0"}, True],
                    )["cell"]["data"]["content"],
                    "receipt": aggregate["outputs_data"][2],
                }
                answer = js_settlement.built(
                    self,
                    "dao-phase-two",
                    **js_common,
                    **js_evidence,
                    sponsor=js_settlement.sponsor_of(
                        {"tx_hash": withdrawal_hash, "index": "0x1"},
                        withdrawal["outputs"][1],
                        js_lock_dep,
                    ),
                    withdrawing={
                        "out_point": {"tx_hash": withdrawal_hash, "index": "0x0"},
                        "receipt_out_point": receipt_dep["out_point"],
                        "data": withdrawing_data,
                        **js_deposit,
                    },
                    deposit_header=aggregate_header,
                    withdraw_header=withdrawal_header,
                    record_out_point={"tx_hash": entropy_hash, "index": "0x0"},
                )
                js_tx = answer["tx"]
                # Everything the contracts read must be identical to the
                # transaction assembled from the Rust exporter's bytes.
                self.assertEqual(int(answer["realized"]), realized)
                self.assertEqual(js_tx["inputs"][0], funding_tx["inputs"][0])
                self.assertEqual(js_tx["header_deps"], funding_tx["header_deps"])
                self.assertEqual(js_tx["outputs"][0], funding_tx["outputs"][0])
                self.assertEqual(js_tx["outputs_data"][0], funding_tx["outputs_data"][0])
                self.assertEqual(js_tx["witnesses"][0], funding_tx["witnesses"][0])
                funding_tx = js_tx
                print(
                    "DAOWOW JS builder: phase two built and matched, realized",
                    answer["realized"],
                    "liabilities",
                    len(answer["liabilities"]),
                    "prizes",
                    len(answer["prizes"]),
                    flush=True,
                )
            funding_hash, _ = commit(node, funding_tx)
            if js:
                # Prizes are unredeemed and far below the settlement cell's own
                # floor, so the only participant is the LAST one and cannot be
                # paid yet. The builder must say so rather than build it.
                refused = js_settlement.build(
                    "payout",
                    **js_common,
                    **js_evidence,
                    sponsor=js_settlement.sponsor_of(
                        {"tx_hash": funding_hash, "index": "0x1"},
                        funding_tx["outputs"][1],
                        js_lock_dep,
                    ),
                    funding={
                        "out_point": {"tx_hash": funding_hash, "index": "0x0"},
                        **funding_tx["outputs"][0],
                        "data": funding_tx["outputs_data"][0],
                    },
                    participant_locks=[fixture["lock"]],
                )
                self.assertFalse(refused["ok"], "a payout before redemption was built")
                self.assertIn("redeemed", refused["error"])
                print("DAOWOW JS builder: payout before redemption refused", flush=True)
            live = node.rpc(
                "get_live_cell", [{"tx_hash": funding_hash, "index": "0x0"}, True]
            )
            self.assertEqual(live["status"], "live")
            self.assertEqual(live["cell"]["output"], funding_tx["outputs"][0])
            self.assertEqual(live["cell"]["data"]["content"], settlement["data"])
            # The winning claim (minted in the append at the first claim
            # output) redeems the batch prize into its own lock. The prize is
            # far below a cell's occupied capacity, so the sponsor tops the
            # payment cell up; the funding successor keeps the principal.
            redemption = settlement["redemption"]
            claim_index = 4 if partial else 3
            claim_output = entry_tx["outputs"][claim_index]
            self.assertEqual(claim_output["lock"], fixture["lock"])
            payment_capacity = max(redemption["amount"], 61 * CKB)
            topup = payment_capacity - redemption["amount"]
            redeem_change = copy.deepcopy(funding_tx["outputs"][1])
            redeem_change["capacity"] = hex(
                int(redeem_change["capacity"], 16) - topup - 100_000
            )
            redeem = {
                "version": "0x0",
                "cell_deps": protocol_deps,
                "header_deps": [],
                "inputs": [
                    input_cell(funding_hash, 0),
                    input_cell(entry_hash, claim_index),
                    input_cell(funding_hash, 1),
                ],
                "outputs": [
                    {
                        "capacity": hex(realized - settlement["prize_pool"]),
                        "lock": settlement["lock"],
                        "type": settlement["type"],
                    },
                    claim_output,
                    {
                        "capacity": hex(payment_capacity),
                        "lock": fixture["lock"],
                        "type": None,
                    },
                    redeem_change,
                ],
                "outputs_data": [
                    redemption["funding_data_after"],
                    redemption["claim_data_after"],
                    "0x",
                    "0x",
                ],
                "witnesses": [redemption["witness"], "0x", "0x"],
            }
            unchanged_claim = copy.deepcopy(redeem)
            unchanged_claim["outputs_data"][1] = entry_tx["outputs_data"][claim_index]
            with self.assertRaisesRegex(RuntimeError, "ValidationFailure"):
                node.rpc("send_transaction", [unchanged_claim, "passthrough"])
            # A winner that still owes redemptions cannot retire, and this is
            # the only point in the round where that is constructible on a live
            # chain: the winning claim is drawn, live, and has redeemed
            # nothing, so its paid_count (0) sits below the obligation universe
            # (the sealed round's accepted-batch count). One transaction later
            # the cell is spent, and the successor's paid_count has caught up,
            # so the refusal can never be reached again from here.
            #
            # Guarded on the retirement fixture because only the retiring
            # histories export the schedule witness that retire() reads.
            if "retirement" in settlement:
                premature_retire = {
                    "version": "0x0",
                    "cell_deps": protocol_deps
                    + [
                        {
                            "out_point": {"tx_hash": entropy_hash, "index": "0x0"},
                            "dep_type": "code",
                        }
                    ],
                    "header_deps": [],
                    "inputs": [input_cell(entry_hash, claim_index)],
                    "outputs": [
                        {
                            "capacity": hex(
                                int(claim_output["capacity"], 16) - 100_000
                            ),
                            "lock": claim_output["lock"],
                            "type": None,
                        }
                    ],
                    "outputs_data": ["0x"],
                    "witnesses": [settlement["retirement"]["schedule_witness"]],
                }
                with self.assertRaises(RuntimeError) as caught:
                    node.rpc("send_transaction", [premature_retire, "passthrough"])
                message = str(caught.exception)
                print(
                    "DAOWOW premature winner retire refused:",
                    message,
                    flush=True,
                )
                self.assertIn("ValidationFailure", message)
                # CLAIM_ERROR_INCOMPLETE. Asserted exactly rather than as a
                # bare ValidationFailure: a malformed fixture would also be
                # refused, and would prove nothing. -99 says a genuine winner
                # was told to come back once it has collected everything,
                # which is distinct from CLAIM_ERROR_IMPOSSIBLE (-104), the
                # non-winner-carrying-payments case.
                self.assertIn("error code -99", message)
            redeem_hash, _ = commit(node, redeem)
            for i in (0, 1):
                live = node.rpc(
                    "get_live_cell", [{"tx_hash": redeem_hash, "index": hex(i)}, True]
                )
                self.assertEqual(live["status"], "live")
                self.assertEqual(
                    live["cell"]["data"]["content"], redeem["outputs_data"][i]
                )
            paid_prize = node.rpc(
                "get_live_cell", [{"tx_hash": redeem_hash, "index": "0x2"}, True]
            )
            self.assertEqual(paid_prize["status"], "live")
            self.assertEqual(
                int(paid_prize["cell"]["output"]["capacity"], 16), payment_capacity
            )
            with self.assertRaisesRegex(RuntimeError, "Unknown|Dead|Resolve"):
                node.rpc("send_transaction", [redeem, "passthrough"])
            print(
                "DAOWOW claim redeemed the batch prize",
                redeem_hash,
                "prize",
                redemption["amount"],
                "topup",
                topup,
                flush=True,
            )
            payout_change = copy.deepcopy(redeem_change)
            payout_change["capacity"] = hex(
                int(payout_change["capacity"], 16) - 100_000
            )
            payout_change["lock"]["args"] = "0x73706f6e736f72"
            payout = {
                "version": "0x0",
                "cell_deps": protocol_deps,
                "header_deps": [],
                "inputs": [input_cell(redeem_hash, 0), input_cell(redeem_hash, 3)],
                "outputs": [
                    {
                        "capacity": hex(settlement["principal"]),
                        "lock": fixture["lock"],
                        "type": None,
                    },
                    payout_change,
                ],
                "outputs_data": ["0x", "0x"],
                "witnesses": [settlement["payout_witness"], "0x"],
            }
            underpaid = copy.deepcopy(payout)
            underpaid["outputs"][0]["capacity"] = hex(settlement["principal"] - 1)
            underpaid["outputs"][1]["capacity"] = hex(
                int(payout_change["capacity"], 16) + 1
            )
            with self.assertRaisesRegex(RuntimeError, "ValidationFailure"):
                node.rpc("send_transaction", [underpaid, "passthrough"])
            if js:
                funding_live = node.rpc(
                    "get_live_cell", [{"tx_hash": redeem_hash, "index": "0x0"}, True]
                )["cell"]
                answer = js_settlement.built(
                    self,
                    "payout",
                    **js_common,
                    **js_evidence,
                    sponsor=js_settlement.sponsor_of(
                        payout["inputs"][1]["previous_output"],
                        redeem["outputs"][3],
                        js_lock_dep,
                        change_lock=payout_change["lock"],
                    ),
                    funding={
                        "out_point": {"tx_hash": redeem_hash, "index": "0x0"},
                        **funding_live["output"],
                        "data": funding_live["data"]["content"],
                    },
                    participant_locks=[fixture["lock"]],
                )
                js_tx = answer["tx"]
                self.assertTrue(answer["final"], "the last payout must close the cell")
                self.assertEqual(answer["paid"], 1)
                self.assertEqual(js_tx["inputs"][0], payout["inputs"][0])
                self.assertEqual(js_tx["outputs"][0], payout["outputs"][0])
                self.assertEqual(js_tx["witnesses"][0], payout["witnesses"][0])
                payout = js_tx
                print("DAOWOW JS builder: final payout built and matched", flush=True)
            payout_hash, payout_header = commit(node, payout)
            live = node.rpc(
                "get_live_cell", [{"tx_hash": payout_hash, "index": "0x0"}, True]
            )
            self.assertEqual(live["status"], "live")
            self.assertEqual(live["cell"]["output"], payout["outputs"][0])
            self.assertEqual(live["cell"]["data"]["content"], "0x")
            self.assertEqual(
                node.rpc("get_transaction", [payout_hash])["transaction"]["inputs"],
                payout["inputs"],
            )
            print(
                "DAOWOW computed funding and final payout committed",
                funding_hash,
                payout_hash,
                payout_header["number"],
                "principal",
                settlement["principal"],
                "prize",
                settlement["prize"],
                flush=True,
            )
            if recover:
                recover_settlement_history(
                    self, node, funding_tx, funding_hash, redeem, redeem_hash
                )
            if partial:
                refunded = node.rpc(
                    "get_live_cell",
                    [{"tx_hash": partial_refund["refund_hash"], "index": "0x0"}, True],
                )
                self.assertEqual(refunded["status"], "live")
                self.assertEqual(
                    refunded["cell"]["output"],
                    partial_refund["transaction"]["outputs"][0],
                )
                self.assertEqual(refunded["cell"]["data"]["content"], "0x")
                self.assertEqual(
                    int(refunded["cell"]["output"]["capacity"], 16), 400 * CKB
                )
                self.assertEqual(
                    int(live["cell"]["output"]["capacity"], 16), 400 * CKB
                )
                for txhash, out_index in [
                    (aggregate_hash, 1),
                    (withdrawal_hash, 0),
                    (funding_hash, 0),
                ]:
                    self.assertIn(
                        node.rpc(
                            "get_live_cell",
                            [{"tx_hash": txhash, "index": hex(out_index)}, True],
                        )["status"],
                        ("unknown", "dead"),
                    )
                print(
                    "DAOWOW partial round complete; excluded refund remains live",
                    partial_refund["refund_hash"],
                    payout_hash,
                    flush=True,
                )
                if retire:
                    self.assertIn(
                        "retirement", settlement, "missing retirement fixture"
                    )
                    # The excluded entry's claim (shard 0, position 1) was
                    # never drawn and never redeemed; the accepted entry's
                    # claim (shard 0, position 0) is the sole winner and has
                    # just redeemed the round's one and only batch above.
                    retire_sealed_round(
                        self,
                        node,
                        protocol_deps,
                        entropy_hash,
                        settlement["retirement"],
                        entry_hash,
                        entry_tx,
                        5,
                        redeem_hash,
                        redeem,
                    )
