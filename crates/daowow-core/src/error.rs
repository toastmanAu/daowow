//! Error codes shared between daowow-core and the on-chain contracts.
//!
//! On-chain scripts must return these exact i8 values so adversarial tests
//! and the independent verifier can distinguish failure causes.

/// daowow-core generic errors (host side uses this enum; scripts use the codes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoreError {
    Encoding,
    Overflow,
    InvalidArgument,
    MembershipProof,
    AppendProof,
    StateTransition,
    Conservation,
    Unknown,
}

// Contract error code conventions (i8 return of script `main`; the whole
// negative space is -1..=-128):
//   -1..-15    shared errors
//   -16..-27   round-type
//   -28..-41   entry-shard-type
//   -42..-55   entry-lock
//   -56..-70   dao-lock
//   -71..-85   settlement-type
//   -86..-90   accumulator-bench
//   -91..-100  claim mode of entry-shard-type
//   -101..-128 reserved
pub mod codes {
    // shared
    pub const ERROR_ENCODING: i8 = -1;
    pub const ERROR_OVERFLOW: i8 = -2;
    pub const ERROR_INVALID_ARGUMENT: i8 = -3;
    pub const ERROR_MEMBERSHIP_PROOF: i8 = -4;
    pub const ERROR_APPEND_PROOF: i8 = -5;
    pub const ERROR_STATE_TRANSITION: i8 = -6;
    pub const ERROR_CONSERVATION: i8 = -7;
    pub const ERROR_UNKNOWN: i8 = -8;

    // round-type
    pub const ROUND_ERROR_VERSION: i8 = -16;
    pub const ROUND_ERROR_CONFIG: i8 = -17;
    pub const ROUND_ERROR_TIMING: i8 = -18;
    pub const ROUND_ERROR_SHARD_COUNT: i8 = -19;
    pub const ROUND_ERROR_TICKET_PRICE: i8 = -20;
    pub const ROUND_ERROR_UPDATE: i8 = -21;

    // entry-shard-type
    pub const SHARD_ERROR_DATA: i8 = -28;
    pub const SHARD_ERROR_STATE: i8 = -29;
    pub const SHARD_ERROR_SEQUENCE: i8 = -30;
    pub const SHARD_ERROR_COUNTERS: i8 = -31;
    pub const SHARD_ERROR_ROUND_MISMATCH: i8 = -32;
    pub const SHARD_ERROR_ENTRY_CELL: i8 = -33;
    pub const SHARD_ERROR_FROZEN: i8 = -34;
    pub const SHARD_ERROR_GROUP: i8 = -35;
    pub const SHARD_ERROR_CREATE: i8 = -36;
    pub const SHARD_ERROR_CONFIG_DEP: i8 = -37;
    pub const SHARD_ERROR_CLAIM_CELL: i8 = -38;

    // entry-lock
    pub const ENTRY_ERROR_DATA: i8 = -42;
    pub const ENTRY_ERROR_ROUND_MISMATCH: i8 = -43;
    pub const ENTRY_ERROR_SHARD_MISMATCH: i8 = -44;
    pub const ENTRY_ERROR_NOT_AGGREGATION: i8 = -45;
    pub const ENTRY_ERROR_REFUND_DESTINATION: i8 = -46;
    pub const ENTRY_ERROR_REFUND_CONDITION: i8 = -47;
    pub const ENTRY_ERROR_LOCK_ARGS: i8 = -48;
    pub const ENTRY_ERROR_BATCH_BINDING: i8 = -49;

    // dao-lock
    pub const DAO_ERROR_ARGS: i8 = -56;
    pub const DAO_ERROR_PHASE1_LOCK_SUBSTITUTION: i8 = -57;
    pub const DAO_ERROR_PHASE1_STRUCTURE: i8 = -58;
    pub const DAO_ERROR_PHASE2_DESTINATION: i8 = -59;
    pub const DAO_ERROR_GROUP: i8 = -60;

    // settlement-type
    pub const SETTLE_ERROR_DATA: i8 = -71;
    pub const SETTLE_ERROR_CONSERVATION: i8 = -72;
    pub const SETTLE_ERROR_PROOF: i8 = -73;
    pub const SETTLE_ERROR_CURSOR: i8 = -74;
    pub const SETTLE_ERROR_DUPLICATE: i8 = -75;
    pub const SETTLE_ERROR_ROUND_MISMATCH: i8 = -76;
    pub const SETTLE_ERROR_REDEEM: i8 = -77;

    // accumulator-bench
    pub const BENCH_ERROR_WORKLOAD: i8 = -86;
    pub const BENCH_ERROR_FAILED: i8 = -87;

    // claim mode of entry-shard-type (reserved range -91..)
    pub const CLAIM_ERROR_ARGS: i8 = -91;
    pub const CLAIM_ERROR_DATA: i8 = -92;
    pub const CLAIM_ERROR_GROUP: i8 = -93;
    pub const CLAIM_ERROR_MINT: i8 = -94;
    pub const CLAIM_ERROR_TRANSITION: i8 = -95;
    pub const CLAIM_ERROR_RETIRE: i8 = -96;
    pub const CLAIM_ERROR_REDEEM: i8 = -97;
}

impl CoreError {
    pub fn to_code(self) -> i8 {
        use codes::*;
        match self {
            CoreError::Encoding => ERROR_ENCODING,
            CoreError::Overflow => ERROR_OVERFLOW,
            CoreError::InvalidArgument => ERROR_INVALID_ARGUMENT,
            CoreError::MembershipProof => ERROR_MEMBERSHIP_PROOF,
            CoreError::AppendProof => ERROR_APPEND_PROOF,
            CoreError::StateTransition => ERROR_STATE_TRANSITION,
            CoreError::Conservation => ERROR_CONSERVATION,
            CoreError::Unknown => ERROR_UNKNOWN,
        }
    }
}
