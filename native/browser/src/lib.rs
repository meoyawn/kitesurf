mod bridge;
#[cfg(feature = "trace")]
mod trace;
mod runtime;
mod memory;

#[global_allocator]
static ALLOCATOR: memory::BrowserAllocator = memory::BrowserAllocator::new();

#[unsafe(no_mangle)]
pub extern "C" fn __rquickjs_host_now_us() -> f64 { js_sys::Date::now() * 1000.0 }
