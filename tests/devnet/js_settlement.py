"""Drive the JavaScript gate 3c builders from the isolated devnet histories.

The Python histories already build every settlement transaction from the Rust
exporter's canonical bytes. With ``js=True`` each of the three settlement
transactions is ALSO built by the JavaScript builders, compared against the
Python one where the two must agree, and then it is the JavaScript
transaction that is sent to the node.

Two independent implementations agreeing proves little about a node; a node
accepting one proves little about the other. This does both.
"""

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = Path(__file__).resolve().parent / "js_settlement.mjs"


def build(step, **request):
    """Run one builder. Returns the script's answer; raises if it crashed."""
    result = subprocess.run(
        ["node", str(SCRIPT)],
        input=json.dumps({"step": step, **request}).encode(),
        capture_output=True,
        cwd=ROOT,
        timeout=60,
        check=False,
    )
    if result.returncode:
        raise RuntimeError(
            f"js builder {step} crashed: {result.stderr.decode(errors='replace')}"
        )
    return json.loads(result.stdout)


def built(test, step, **request):
    answer = build(step, **request)
    test.assertTrue(answer["ok"], f"js builder {step} refused: {answer.get('error')}")
    return answer


def script_points(node, genesis):
    """Where each protocol binary sits in this devnet's genesis."""
    points = {}
    for name, code in node.protocol_codes.items():
        wanted = "0x" + code.hex()
        for tx in genesis["transactions"]:
            for i, data in enumerate(tx["outputs_data"]):
                if data == wanted:
                    points[name] = {"tx_hash": tx["hash"], "index": hex(i)}
    return points


def fixture_lock_dep(node, genesis):
    wanted = "0x" + node.fixture_code.hex()
    for tx in genesis["transactions"]:
        for i, data in enumerate(tx["outputs_data"]):
            if data == wanted:
                return {
                    "out_point": {"tx_hash": tx["hash"], "index": hex(i)},
                    "dep_type": "code",
                }
    raise AssertionError("the fixture lock's code cell is not in genesis")


def spent_cells(node, transaction):
    """The cells a committed transaction consumed, with their data."""
    cells = []
    for item in transaction["inputs"]:
        previous = item["previous_output"]
        source = node.rpc("get_transaction", [previous["tx_hash"]])["transaction"]
        index = int(previous["index"], 16)
        cells.append({**source["outputs"][index], "data": source["outputs_data"][index]})
    return cells


def sponsor_of(out_point, cell, lock_dep, change_lock=None):
    return {
        "out_point": out_point,
        "capacity": str(int(cell["capacity"], 16)),
        "lock": change_lock or cell["lock"],
        "lock_deps": [lock_dep],
    }
