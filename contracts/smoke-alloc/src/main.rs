#![no_std]
#![no_main]

use ckb_std::entry;
use daowow_contracts_common::daowow_alloc;

entry!(main);

fn main() -> i8 {
    let v: alloc::vec::Vec<u8> = alloc::vec![1u8, 2, 3];
    if v.len() == 3 {
        0
    } else {
        -1
    }
}

daowow_alloc!();
