# Suggested Repository Layout

```text
daowow/
├── START_HERE.md
├── AGENTS.md
├── Cargo.toml
├── package.json
├── pnpm-workspace.yaml
├── rust-toolchain.toml
│
├── contracts/
│   ├── round-type/
│   ├── entry-shard-type/
│   ├── entry-lock/
│   ├── dao-lock/
│   ├── batch-type/
│   ├── reveal-type/
│   └── settlement-type/
│
├── crates/
│   ├── daowow-core/
│   ├── daowow-molecule/
│   └── daowow-test-utils/
│
├── packages/
│   ├── sdk/
│   ├── coordinator/
│   ├── keeper/
│   └── verifier/
│
├── apps/
│   ├── web/                 # later
│   └── explorer/            # later
│
├── schemas/
│   └── daowow.mol
│
├── tests/
│   ├── vectors/
│   ├── integration/
│   └── adversarial/
│
├── deployments/
│   ├── devnet/
│   └── testnet/
│
└── docs/
    ├── protocol.md
    ├── architecture.md
    ├── threat-model.md
    └── ADR/
```

## Boundary rule

`daowow-core` must contain deterministic protocol logic with no RPC/network dependency. On-chain and TypeScript components should consume equivalent rules/test vectors rather than independently re-inventing protocol math.
