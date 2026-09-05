//! CKB default hash (blake2b-256, personalization "ckb-default-hash").
//!
//! This is the only hash function used anywhere in DAOWOW consensus code.
//! Domain separation is always achieved by prefixing explicit domain strings
//! to the hashed input (see leaf.rs and accumulator modules).

use blake2b_ref::Blake2bBuilder;

pub const CKB_HASH_PERSONALIZATION: &[u8] = b"ckb-default-hash";
pub const HASH_LEN: usize = 32;

pub type Hash32 = [u8; HASH_LEN];

/// Streaming blake2b-256 with the CKB personalization.
pub struct Blake2b256(blake2b_ref::Blake2b);

impl Blake2b256 {
    pub fn new() -> Self {
        Self(build())
    }

    pub fn update(&mut self, data: &[u8]) {
        self.0.update(data);
    }

    pub fn finalize(self) -> Hash32 {
        let mut out = [0u8; HASH_LEN];
        self.0.finalize(&mut out);
        out
    }
}

impl Default for Blake2b256 {
    fn default() -> Self {
        Self::new()
    }
}

fn build() -> blake2b_ref::Blake2b {
    Blake2bBuilder::new(HASH_LEN)
        .personal(CKB_HASH_PERSONALIZATION)
        .build()
}

/// One-shot CKB blake2b-256 over concatenated slices.
pub fn ckb_hash256(parts: &[&[u8]]) -> Hash32 {
    let mut h = Blake2b256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize()
}

pub fn ckb_hash256_one(data: &[u8]) -> Hash32 {
    ckb_hash256(&[data])
}

#[cfg(test)]
mod tests {
    use super::*;

    // Known CKB blake2b personalization sanity checks.
    // blake2b-256(personal="ckb-default-hash", input="") == ?
    // We assert determinism and known vectors generated with the same builder;
    // cross-language vectors live in tests/vectors/.
    #[test]
    fn empty_input_deterministic() {
        let a = ckb_hash256_one(b"");
        let b = ckb_hash256(&[]);
        assert_eq!(a, b);
        assert_eq!(a.len(), 32);
    }

    #[test]
    fn known_vector_daowow() {
        // Frozen vector; must match TypeScript implementation later.
        // H("DAOWOW_DOMAIN_TEST_V1")
        let h = ckb_hash256_one(b"DAOWOW_DOMAIN_TEST_V1");
        assert_eq!(
            hex(&h),
            "ba768205ea81928e6e646b98324d62d38704b27f079c226069fa9ead8753ed8f"
        );
    }

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{:02x}", x)).collect()
    }
}
