#!/usr/bin/env python3
"""Print the name of the locally built contract whose bytes hash to the given
CKB data hash, or nothing if none match.

Used by tools/reclaim-cells.sh to tell a SUPERSEDED code cell from the
CURRENT build of a contract. Nothing on chain distinguishes them: a contract
unchanged by a rebuild has no references yet is still the live deployment, so
"unreferenced" alone is not enough to justify consuming a cell.

Usage: which-local-binary.py <0x-prefixed data hash> [bin-dir]
"""
import hashlib
import pathlib
import sys

BIN_DIR = pathlib.Path("target/riscv64imac-unknown-none-elf/release")


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    want = sys.argv[1].removeprefix("0x").lower()
    bin_dir = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else BIN_DIR
    if not bin_dir.is_dir():
        return 0
    for path in sorted(bin_dir.iterdir()):
        # Contract binaries have no extension; skip build directories and
        # intermediates so this cannot match something incidental.
        if not path.is_file() or path.suffix:
            continue
        digest = hashlib.blake2b(
            path.read_bytes(), digest_size=32, person=b"ckb-default-hash"
        ).hexdigest()
        if digest == want:
            print(path.name)
            return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
