use std::{env, fs, path::PathBuf};

fn main() {
    let source = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap())
        .join("../../vendor/obscura/crates/obscura-render/src").canonicalize()
        .expect("Run task setup to initialize the pinned Obscura submodule");
    let output = PathBuf::from(env::var("OUT_DIR").unwrap());
    let dom_path = source.join("dom.rs");
    let dom = fs::read_to_string(&dom_path).unwrap();
    // Only the renderer's two profiling clocks need a WASM host clock.
    assert_eq!(dom.matches("std::time::Instant::now()").count(), 2);
    let retained = "custom_properties.insert(id, this_props.clone());";
    assert_eq!(dom.matches(retained).count(), 1);
    let dom = dom.replace("std::time::Instant::now()", "web_time::Instant::now()")
        .replace(retained, "// Geometry requests rebuild styles; retain only the active cascade's inherited maps.");
    fs::write(output.join("dom.rs"), dom).unwrap();
    let mut entry = String::new();
    for line in fs::read_to_string(source.join("lib.rs")).unwrap().lines() {
        if line.starts_with("//!") {
            entry.push_str(&line.replacen("//!", "//", 1));
        } else {
            if let Some(module) = line.strip_prefix("pub mod ").or_else(|| line.strip_prefix("mod "))
                .and_then(|value| value.strip_suffix(';')) {
                let path = if module == "dom" { output.join("dom.rs") } else { source.join(format!("{module}.rs")) };
                entry.push_str(&format!("#[path = {:?}]\n", path.to_str().unwrap()));
            }
            entry.push_str(line);
        }
        entry.push('\n');
    }
    fs::write(output.join("layout.rs"), entry).unwrap();
    println!("cargo:rerun-if-changed={}", source.display());
}
