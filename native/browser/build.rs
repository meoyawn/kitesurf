use std::{env, fs, path::PathBuf};

fn main() {
    let source = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap())
        .join("../../vendor/obscura/crates/obscura-js/js/bootstrap.js");
    let bootstrap = fs::read_to_string(&source).expect("Run task setup to initialize Obscura");
    // Native DOM callbacks now return JS values, preserving the bootstrap's mutation bookkeeping.
    let from = "JSON.parse(_dom(cmd, a1, a2))";
    assert_eq!(bootstrap.matches(from).count(), 1);
    let bootstrap = bootstrap.replace(from, "_dom(cmd, a1, a2)");
    // QuickJS copies strings eagerly; native buffer callbacks avoid per-character strings
    // and dense JavaScript byte arrays when encoding/decoding downloaded scripts.
    let mut bootstrap = bootstrap;
    let start = "    encode(str) {\n      str = String(str);";
    let end = "    encodeInto(str, dest)";
    assert_eq!(bootstrap.matches(start).count(), 1);
    assert_eq!(bootstrap.matches(end).count(), 1);
    let start = bootstrap.find(start).unwrap();
    let end = start + bootstrap[start..].find(end).unwrap();
    bootstrap.replace_range(start..end, "    encode(str) { return Deno.core.ops.op_text_encode(String(str === undefined ? '' : str).toWellFormed()); }\n");
    let start = "      // Fast path: plain UTF-8, non-fatal (Response/Blob text, most pages).";
    let end = "      // Legacy encodings / fatal mode: encoding_rs via the op.";
    assert_eq!(bootstrap.matches(start).count(), 1);
    assert_eq!(bootstrap.matches(end).count(), 1);
    let start = bootstrap.find(start).unwrap();
    let end = start + bootstrap[start..].find(end).unwrap();
    bootstrap.replace_range(start..end, "");
    let from = "JSON.parse(Deno.core.ops.op_text_decode(this.encoding, bytes, this.fatal, this.ignoreBOM))";
    assert_eq!(bootstrap.matches(from).count(), 1);
    let bootstrap = bootstrap.replace(from, "Deno.core.ops.op_text_decode(this.encoding, bytes, this.fatal, this.ignoreBOM)");
    fs::write(PathBuf::from(env::var("OUT_DIR").unwrap()).join("bootstrap.js"), bootstrap).unwrap();
    println!("cargo:rerun-if-changed={}", source.display());
}
