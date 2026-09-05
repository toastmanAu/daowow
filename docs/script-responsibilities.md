# Script Responsibilities

## DAOWOWRoundType

Purpose: establish unique immutable Round configuration.

Must validate:
- supported protocol version;
- valid configuration encoding;
- ticket price > 0;
- valid timing order;
- valid shard count;
- prize schedule / fee hashes are present;
- unique identity / Type ID strategy.

Should not be consumed during ordinary Round progression.

## DAOWOWEntryShardType

Purpose: serialize only within one shard and commit every accepted Entry.

Must validate OPEN update:
- same Round and shard IDs;
- sequence increments exactly one;
- exactly authorised accumulator transition;
- counters increase exactly by Entry values created in transaction;
- no unsupported state mutation.

Must validate freeze:
- entry deadline reached;
- final counters/root preserved;
- OPEN -> FROZEN only;
- no re-opening.

## DAOWOWEntryLock

Permitted spends only:
1. validated DAO aggregation for same Round and accepted membership proof;
2. refund after failure condition to committed participant lock.

Must reject arbitrary lock destinations and operator custody.

## DAOWOWDAOLock

Purpose: keep Round funds non-custodial while native DAO type validates DAO mechanics.

Deposit -> phase one:
- corresponding output remains DAOWOW-authorised;
- Round/batch identity preserved;
- lock substitution prohibited;
- native same-index withdrawal structure preserved.

Phase two:
- realised capacity flows only to authorised batch/finalised settlement state;
- keeper compensation bounded by Round rules;
- no arbitrary operator outputs.

## DAOWOWBatchType

Purpose: prove aggregate backing/accounting.

Must bind:
- Round ID;
- batch ID;
- consumed Entry membership;
- principal sum;
- ticket count;
- batch Entry commitment;
- lifecycle stage.

## DAOWOWRevealType

Purpose: validate participant entropy reveal against previously committed value.

Do not make liveness dependent on every reveal.

## DAOWOWSettlementType

Purpose: preserve exact Round liabilities while settlement shards pay users.

Must enforce:
- deterministic shard ownership/allocation;
- funding conservation;
- payout amounts match committed liabilities and prizes;
- no repeated payout within shard progression;
- keeper reward bounds;
- no stranded/unexplained value.
