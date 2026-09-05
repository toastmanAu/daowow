//! DAOWOW deterministic protocol primitives.
//!
//! This crate is the single source of truth for every consensus-critical
//! byte layout, hash domain and pure algorithm used by DAOWOW. It compiles
//! `no_std` (for CKB-VM contracts) and with `std` (for hosts, tests and the
//! deterministic vector generator).
//!
//! Boundary rule (docs/repo-layout.md): no RPC, no network, no clocks.
//! Everything here is a pure function of its inputs.

#![cfg_attr(not(feature = "std"), no_std)]

// Contracts run on CKB-VM with the ckb-std allocator; the vendored SMT
// verifier requires alloc (Vec/BTreeMap) on both host and chain.
extern crate alloc;

pub mod accounting;
pub mod accumulator;
pub mod draw;
pub mod encoding;
pub mod error;
pub mod hash;
pub mod leaf;
pub mod shard;
pub mod witness;

pub use error::CoreError;
