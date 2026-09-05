//! Shared on-chain helpers for DAOWOW contracts (ckb-std based).

#![no_std]

extern crate alloc;

use alloc::vec::Vec;

use ckb_std::ckb_constants::Source;
use ckb_std::ckb_types::packed::Script;
use ckb_std::high_level::{load_cell, load_cell_data, load_script};
use daowow_core::encoding::{
    RoundConfigV1, EntryShardDataV1, ScriptRef, ROUND_CONFIG_SIZE, SHARD_DATA_SIZE,
    SHARD_STATE_FROZEN,
};

pub fn script_matches(script: &Script, r: &ScriptRef) -> bool {
    let code_hash: [u8; 32] = script.code_hash().into();
    code_hash == r.code_hash && u8::from(script.hash_type()) == r.hash_type
}

/// Load the running script.
pub fn current_script() -> Script {
    load_script().expect("load script")
}

/// Iterate all dep cells and find the RoundConfig cell whose type script
/// matches `round_type_ref` and whose data binds `round_id`.
pub fn find_round_config(round_type_ref: &ScriptRef, round_id: &[u8; 32]) -> Option<RoundConfigV1> {
    let mut i = 0usize;
    loop {
        let cell = match load_cell(i, Source::CellDep) {
            Ok(c) => c,
            Err(_) => return None,
        };
        if let Some(t) = cell.type_().to_opt() {
            if script_matches(&t, round_type_ref) {
                if let Ok(data) = load_cell_data(i, Source::CellDep) {
                    if data.len() == ROUND_CONFIG_SIZE {
                        if let Ok(cfg) = RoundConfigV1::decode(&data) {
                            if cfg.round_id == *round_id {
                                return Some(cfg);
                            }
                        }
                    }
                }
            }
        }
        i += 1;
    }
}

/// Iterate dep cells and find a FROZEN entry shard cell (matching the
/// configured shard type script) bound to `round_id`.
/// Returns its shard data (the frozen commitment).
pub fn find_frozen_shard(
    shard_type_ref: &ScriptRef,
    round_id: &[u8; 32],
) -> Option<EntryShardDataV1> {
    let mut i = 0usize;
    loop {
        let cell = match load_cell(i, Source::CellDep) {
            Ok(c) => c,
            Err(_) => return None,
        };
        let tprobe = cell.type_().to_opt();
        if let Some(t) = tprobe {
            if script_matches(&t, shard_type_ref) {
                if let Ok(data) = load_cell_data(i, Source::CellDep) {
                    if data.len() == SHARD_DATA_SIZE {
                        if let Ok(s) = EntryShardDataV1::decode(&data) {
                            if s.round_id == *round_id && s.state == SHARD_STATE_FROZEN {
                                return Some(s);
                            }
                        }
                    }
                }
            }
        }
        i += 1;
    }
}

/// Iterate input cells; return absolute indices of cells whose type script
/// hash equals `type_hash` (32 bytes).
pub fn input_indices_with_type_hash(type_hash: &[u8; 32]) -> Vec<usize> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while let Ok(h) = ckb_std::high_level::load_cell_type_hash(i, Source::Input) {
        if let Some(h) = h {
            if &h == type_hash {
                out.push(i);
            }
        }
        i += 1;
    }
    out
}

/// Read a full witness as raw bytes (index within the given source scope).
pub fn witness_at(index: usize, source: Source) -> Option<Vec<u8>> {
    ckb_std::high_level::load_witness(index, source).ok()
}

/// Minimal bump allocator replacing ckb-std's buddy allocator, which
/// currently faults on this toolchain (rustc 1.98 / buddy-alloc 0.6).
/// DAOWOW scripts allocate monotonically (proof replay buffers); dealloc is
/// a no-op by design. Total heap: 512 KiB.
/// Install the DAOWOW bump allocator as the global allocator.
#[macro_export]
macro_rules! daowow_alloc {
    () => {
        #[global_allocator]
        static ALLOC: $crate::bump_alloc::BumpAlloc = $crate::bump_alloc::BumpAlloc;
    };
}

pub mod bump_alloc {
    use core::alloc::{GlobalAlloc, Layout};

    pub const HEAP_SIZE: usize = 512 * 1024;

    #[repr(C, align(64))]
    pub struct Heap([u8; HEAP_SIZE]);

    static mut HEAP_MEM: Heap = Heap([0u8; HEAP_SIZE]);
    // CKB-VM scripts are single-threaded; avoid atomics entirely (AMO
    // instructions are not supported by the base CKB-VM ISA).
    static mut CURSOR: usize = 0;

    pub struct BumpAlloc;

    unsafe impl Sync for Heap {}

    unsafe impl GlobalAlloc for BumpAlloc {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            let align = layout.align().max(8);
            let heap_start = (&raw const HEAP_MEM) as *const u8 as usize;
            let offset = CURSOR;
            let aligned = (offset + align - 1) & !(align - 1);
            if aligned + layout.size() > HEAP_SIZE {
                return core::ptr::null_mut();
            }
            CURSOR = aligned + layout.size();
            (heap_start + aligned) as *mut u8
        }

        unsafe fn dealloc(&self, _ptr: *mut u8, _layout: Layout) {}
    }

    /// Current heap usage in bytes (for debugging).
    pub fn heap_usage() -> usize {
        unsafe { CURSOR }
    }
}
