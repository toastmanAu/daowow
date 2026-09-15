# Isolated full-node validation preflight — 2026-09-10

Status: environment preflight only. No node was started, mined, reorganized,
or used to validate a DAOWOW transaction in this checkpoint.

## Observed environment

- Docker daemon access works outside the workspace sandbox (Engine 29.7.2).
- Cached CKB image: `nervos/ckb:v0.209.0`, pinned by repository digest
  `nervos/ckb@sha256:4d6e113b4e95d5b4802e36b9199c585666c0e66ff400b398f3117f36d4f304f8`.
- `ckb init --help` and a dev-chain initialization succeeded in disposable
  containers with `--network none`, read-only root filesystem, all Linux
  capabilities dropped, no-new-privileges, and no host mounts. Generated
  configuration existed only on a 32 MiB `/tmp` tmpfs and was discarded when
  the container exited.
- Initialization used `--chain dev --genesis-message daowow-isolated-validation-v1`.
  The unmodified generated spec reported genesis
  `0x0385a1d5f880d74f9419fbb49137a7294e36b9c696b2ad6ee1ee97b4301a5617`.
  This hash describes these defaults only; modifying the spec requires recording
  the resulting genesis again.

## Defaults that affect the eventual harness

- PoW is `Dummy`, permanent difficulty is enabled, genesis epoch length is 10,
  epoch duration target is 80, and cellbase maturity is zero. These are devnet
  settings, not a testnet consensus-equivalence claim. Native DAO withdrawal
  maturity must still be tested explicitly, including fractional epoch bounds.
- Default maximum block cycles are **10,000,000,000**, exceeding the supplied
  testnet node's previously observed **3,500,000,000**. The validation harness
  must enforce the intended target limits; passing these dev defaults alone is
  insufficient. Default transaction verification limit is **70,000,000** cycles.
- RPC listens on `0.0.0.0:8114`, includes `Debug`, and has no published port in
  these probes. Do not expose this configuration to the LAN. Bootnodes are
  empty, but that alone is not an isolation boundary.
- Mining is disabled until block assembler arguments are supplied. The dev
  spec includes public example-key allocations; those are disposable devnet
  fixtures, never credentials to reuse for testnet or real funds.

## Still required

1. Complete computed winners, authenticated initial entitlements, and payout
   accounting. The owner subsequently approved distributing each batch's own
   yield to the same global winners, with first-prize rounding dust. The proposed
   implementation design is in
   `superpowers/specs/2026-09-10-computed-entitlements-design.md`.
2. Build an isolated, reproducible node/transaction harness with target limits,
   deterministic fixtures, controlled mining and auditable assertions.
3. Verify native DAO maturity boundaries and seal-relative entropy finalization
   before and at their valid boundaries using real node consensus validation.
4. Exercise competing branches and actual reorganization; prove orphaned seal
   anchors/entropy dependencies cannot authorize settlement on the new chain,
   and that canonical rebuilding preserves payout and refund liveness.
5. Record transaction hashes, headers, capacities, fees, rejection reasons and
   canonical state after reorg. VM fixtures and recognized RPC method names
   do not substitute for these checks.

The live node at `192.168.68.134:8114`, historical deployment, and wallet were
not changed or contacted during this preflight.
