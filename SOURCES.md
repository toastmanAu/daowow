# Primary Technical Sources

These are starting points. The coding agent must inspect current upstream docs/source before freezing APIs or constants.

- Nervos RFC 0023 — Deposit and Withdraw in Nervos DAO (bundled at `reference/RFC-0023-dao-deposit-withdraw.md`)
  https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0023-dao-deposit-withdraw/0023-dao-deposit-withdraw.md

- Nervos CKB system scripts / current DAO implementation
  https://github.com/nervosnetwork/ckb-system-scripts
  https://github.com/nervosnetwork/ckb-system-scripts/blob/master/c/dao.c

- ckb-std
  https://github.com/nervosnetwork/ckb-std

- ckb-testtool
  https://github.com/nervosnetwork/ckb-testtool

- Molecule
  https://github.com/nervosnetwork/molecule

- CCC SDK docs
  https://docs.ckbccc.com/en
  https://docs.ckbccc.com/llms.txt
  https://docs.ckbccc.com/skill.md

- CCC repository / agent skills
  https://github.com/ckb-devrel/ccc

## Agent note

Legacy `ckb-sdk-js` and Lumos currently point developers toward CCC for modern TypeScript CKB development. Do not start a new DAOWOW frontend/coordinator implementation on a passively maintained legacy SDK without a documented reason.
