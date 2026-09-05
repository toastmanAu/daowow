# Required deterministic vectors

Create machine-readable JSON vectors for:

1. Round ID derivation.
2. Entry leaf canonical encoding/hash.
3. Each candidate accumulator update/proof.
4. Frozen Round Entry root derivation.
5. Ticket position ranges for uneven Entry sizes.
6. Reveal commitment and missing-reveal fallback.
7. Chain entropy input encoding.
8. Final draw seed.
9. Rejection sampling including a forced rejection case.
10. Duplicate winning-position retry.
11. Prize schedule rounding.
12. Settlement shard assignment.
13. Principal + prize payout calculation.
14. Global conservation equation.
15. Maximum integer boundary / overflow rejection.

Every vector must specify the exact domain separator, byte encoding, endian convention, input bytes and expected output bytes.
