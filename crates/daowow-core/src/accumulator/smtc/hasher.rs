//! Pure-Rust replacement for the vendored crate's blake2b-rs `Blake2bHasher`.
//! Produces identical output: blake2b-256 with the CKB personalization.

use super::h256::H256;
use super::traits::Hasher;
use blake2b_ref::Blake2bBuilder;

pub struct CkbHasher(blake2b_ref::Blake2b);

impl Default for CkbHasher {
    fn default() -> Self {
        CkbHasher(
            Blake2bBuilder::new(32)
                .personal(b"ckb-default-hash")
                .build(),
        )
    }
}

impl Hasher for CkbHasher {
    fn write_h256(&mut self, h: &H256) {
        self.0.update(h.as_slice());
    }

    fn write_byte(&mut self, b: u8) {
        self.0.update(&[b]);
    }

    fn finish(self) -> H256 {
        let mut buf = [0u8; 32];
        self.0.finalize(&mut buf);
        H256::from(buf)
    }
}
