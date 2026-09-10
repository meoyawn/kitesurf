#[cfg(feature = "paint")]
compile_error!("The Worker adapter supports layout only");

include!(concat!(env!("OUT_DIR"), "/layout.rs"));
