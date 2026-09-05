# Initial Coding Agent Prompt

You are the primary implementation agent for **DAOWOW**, a Nervos CKB protocol that pools participant CKB into the native Nervos DAO, preserves each participant's principal liability, and raffles only the realised DAO compensation between positional ticket holders.

Read `START_HERE.md`, `AGENT_HANDOFF.md`, all files under `docs/`, and `reference/RFC-0023-dao-deposit-withdraw.md` before changing code.

Your immediate objective is **not** to build the whole protocol. Build a reproducible CKB development workspace and execute Milestones 0–3: deterministic core primitives, EntryShard prototype, and an empirical accumulator comparison.

Requirements:

- Use current official/maintained CKB tooling rather than remembered APIs.
- Use Rust/ckb-std for scripts and ckb-testtool for script tests unless repository evidence proves a better current choice.
- Use CCC for TypeScript transaction construction. Install/read CCC's Agent Skills/current docs before writing CCC calls.
- Pin all dependency/tool versions.
- Use shannons and integer arithmetic.
- Do not introduce a privileged custody key.
- Do not trust off-chain roots without an on-chain verification mechanism.
- Do not use EVM terminology or architecture where CKB cell semantics differ.
- Record measured cycle counts, transaction sizes, proof sizes and occupied capacity.

Before coding the final accumulator, prototype **SMT, MMR, and incremental binary Merkle** candidates sufficiently to compare append/update cost, membership proof cost, proof size, implementation complexity and auditability on CKB-VM.

At the end of the sprint create `prototype-report.md` with:

1. exact environment/tool versions;
2. working commands;
3. implemented prototype architecture;
4. benchmark table;
5. selected accumulator and ADR;
6. known protocol conflicts or required spec changes;
7. next implementation tasks.

If reality contradicts the handoff spec, preserve safety invariants and update the spec rather than forcing the code to fit an invalid assumption.
