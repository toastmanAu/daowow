//! Vendored from nervosnetwork/sparse-merkle-tree v0.6.1 (MIT licensed),
//! with the blake2b-rs (C) default hasher replaced by a pure-Rust blake2b-ref
//! hasher producing identical output (same algorithm + personalization).
//!
//! Rationale for vendoring rather than depending: sparse-merkle-tree 0.6.1
//! hard-depends on blake2b-rs, which requires a C cross-compiler for
//! riscv64imac; DAOWOW contracts must build with a pure-Rust toolchain.
//! The verify machinery (merkle_proof.rs) is no_std + alloc and is used
//! on-chain unchanged.

#[cfg(feature = "std")]
pub mod default_store;
pub mod error;
pub mod h256;
pub mod hasher;
pub mod merge;
pub mod merkle_proof;
pub mod traits;
pub mod tree;

/// Max stack size can be used when verify compiled proof
pub(crate) const MAX_STACK_SIZE: usize = 257;

pub use h256::H256;
pub use merkle_proof::{CompiledMerkleProof, MerkleProof};
#[cfg(feature = "std")]
pub use tree::SparseMerkleTree;
pub use tree::{BranchKey, BranchNode};
