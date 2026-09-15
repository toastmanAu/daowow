# Full-node closed universe and scheduled entropy — 2026-09-14

The actual isolated DAOWOW history now reaches closure of both ledgers, a
canonical round seal, and authenticated scheduled entropy. These are committed
transactions following the previously validated creation/entry/freeze/DAO
aggregation history, not cells inserted into a VM context.

The Rust fixture exporter derives both closed ledgers and their ordered seal
using canonical encoders. It then encodes an entropy record from the observed
seal inclusion header and the actual headers at offsets +64, +128 and +192.
The shard-zero contract validates those headers when the successor is created.
Sponsor funds supply the seal's occupied-capacity increase.

Focused live verification passed in 12.890 seconds:

- Seal at block 44:
  `0x3d3093ca7db384d190e3523a23ed6ee96cc4800dcae7b7bc95ed548381010498`.
- Entropy record committed at block 304:
  `0x66f9f3e27883be75344a56cead3a283a6e5b01f8ea2bb34432c41296b3756ed4`.
- Missing canonical shard dependency rejects sealing.
- Entropy submission at tip seal+192 rejects as immature.
- After tip seal+256, a wrong scheduled header and forged entropy data reject.
- The valid transaction commits, retaining the expected output script,
  capacity and exact entropy bytes. Inclusion is at least seal+256.

The observed hashes may vary. Log: `/tmp/daowow-entropy-inclusion.log`
(ephemeral). Rust and Python bounded reviews approved the current scope;
strict exporter Clippy and Python formatting checks pass.

Full-suite confirmation: all nine tests passed with Docker opt-in in 124.037
seconds (`/tmp/daowow-2026-09-14-entropy-suite.log`, ephemeral). This includes
four unit tests and five live-node tests. The later entropy transaction was
`0xd4e0c3a97621993a59f02334db269b97830c1805b0b427f5e6752dcaeb6032aa`,
again at block 304. Default tests pass four unit checks and skip the live five.

Boundary limitation: two earlier tests incorrectly expected pool rejection
at tip seal+255 and then +254. Live executions admitted at both heights.
Those assumptions were removed. The current test **does not establish** the
exact pool admission cutoff or rejection of an explicitly submitted premature
block; it submits the valid transaction only after tip seal+256. The
contract's 256-relative-block `since` requirement was not changed.

No production contracts changed in this seal/entropy checkpoint. No testnet
broadcast, live-node mutation or wallet access occurred.

Next: native DAO withdrawal under the DAOWOW lock, computed initial funding
and payouts on this same history. Full protocol-specific reorg/refund/payout
liveness, broader boundary/proof cases, operational tooling and hardened
testnet rollout remain open. Funded rounds are not ready.
