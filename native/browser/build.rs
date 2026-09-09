use std::{env, fs, path::PathBuf};

fn main() {
    let source = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap())
        .join("../../vendor/obscura/crates/obscura-js/js/bootstrap.js");
    let bootstrap = fs::read_to_string(&source).expect("Run task setup to initialize Obscura");
    // Native DOM callbacks now return JS values, preserving the bootstrap's mutation bookkeeping.
    let from = "JSON.parse(_dom(cmd, a1, a2))";
    assert_eq!(bootstrap.matches(from).count(), 1);
    fs::write(PathBuf::from(env::var("OUT_DIR").unwrap()).join("bootstrap.js"), bootstrap.replace(from, "_dom(cmd, a1, a2)")).unwrap();
    println!("cargo:rerun-if-changed={}", source.display());
}
