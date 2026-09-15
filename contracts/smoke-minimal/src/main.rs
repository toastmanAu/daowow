#![no_std]
#![no_main]

use ckb_std::default_alloc;
use ckb_std::entry;

entry!(main);

fn main() -> i8 {
    0
}

default_alloc!(4096, 65536, 64);
