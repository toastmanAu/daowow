"""Gate 3c: the JavaScript settlement builders against a real node.

``test_round_creation`` proves the protocol with transactions assembled in
Python from the Rust exporter's bytes. This runs the same history with the
three settlement transactions built by the JavaScript builders instead (DAO
phase one, DAO phase two, payout), each compared with the Python reference
and then accepted by the isolated node. It proves the TOOLING, not the
protocol.
"""

import os
import unittest

# Imported as a module, not by class name: a TestCase class in this module's
# namespace would be collected, and every history would run a second time.
import test_round_creation


@unittest.skipUnless(
    os.environ.get("DAOWOW_RUN_ISOLATED_NODE") == "1", "explicit Docker opt-in required"
)
class JsSettlementBuilderTests(unittest.TestCase):
    # run_history records these on the class it is called through.
    deposit_epoch_numbers = []
    maturity_deltas = []
    window_width = None

    def test_js_builders_settle_a_round(self):
        test_round_creation.RoundCreationTests.run_history(self, reorg=False, js=True)
        self.assertEqual(self.maturity_deltas, [360])


if __name__ == "__main__":
    unittest.main()
