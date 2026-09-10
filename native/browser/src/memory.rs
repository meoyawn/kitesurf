use std::alloc::{GlobalAlloc, Layout};
use talc::{cell::TalcCell, wasm::{WasmBinning, WasmGrowAndExtend}};

pub struct BrowserAllocator(TalcCell<WasmGrowAndExtend, WasmBinning>);
// The browser is compiled exclusively for single-threaded wasm32, with no signal handlers.
unsafe impl Sync for BrowserAllocator {}
impl BrowserAllocator {
    pub const fn new() -> Self {
        assert!(cfg!(all(target_arch = "wasm32", not(target_feature = "atomics"))));
        Self(TalcCell::new(WasmGrowAndExtend::new()))
    }
    pub fn used(&self) -> usize { self.0.counters().allocated_bytes }
}
// Delegating preserves Talc's allocation and in-place reallocation behavior.
unsafe impl GlobalAlloc for BrowserAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 { unsafe { self.0.alloc(layout) } }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) { unsafe { self.0.dealloc(ptr, layout) } }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 { unsafe { self.0.realloc(ptr, layout, size) } }
}
