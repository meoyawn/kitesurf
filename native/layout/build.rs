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
    let dom = dom.replace("std::time::Instant::now()", "web_time::Instant::now()")
        .replace("HashMap<String, String>", "crate::CustomProperties")
        .replace("let root_props = std::rc::Rc::new(HashMap::new());", "let root_props = std::rc::Rc::new(crate::CustomProperties::new());");
    let dom = dom.replace("fn layout_dom_once(", "#[cfg_attr(feature = \"trace\", tracing::instrument(skip_all))]\nfn layout_dom_once(")
        .replace("fn collect_shadow_stylesheets(", "pub(crate) fn collect_shadow_stylesheets(")
        .replace("fn cascade_node_style(", "#[cfg_attr(feature = \"trace\", tracing::instrument(skip_all))]\nfn cascade_node_style(")
        .replace("let (mut laid, _, mut query, mut cascade_time) =", "#[cfg(feature = \"trace\")]\n{ let _plan = tracing::info_span!(\"style.plan\", reused = retained_reused, fresh = retained_fresh, fallback = retained_fallback, cache_hit = stylesheet_cache_hit, shadows = shadow_sheets.len()).entered(); }\nlet (mut laid, _, mut query, mut cascade_time) =");
    fs::write(output.join("dom.rs"), dom).unwrap();
    // CSS inheritance shares unchanged map branches; component-local variables no longer
    // copy every inherited name and value for every element and every layout pass.
    let css = fs::read_to_string(source.join("css.rs")).unwrap();
    assert!(css.contains("let mut resolved_props = parent_props.clone();"));
    assert!(css.contains("let resolution_environment = resolved_props.clone();"));
    let css = css.replace("HashMap<String, String>", "crate::CustomProperties")
        .replace("    pub(crate) fn get_or_parse(", "    #[cfg_attr(feature = \"trace\", tracing::instrument(name = \"css.compile\", skip_all))]\n    pub(crate) fn get_or_parse(");
    let damage = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("src/css_damage.rs");
    fs::write(output.join("css.rs"), format!("{css}\ninclude!({:?});\n", damage.to_str().unwrap())).unwrap();
    println!("cargo:rerun-if-changed={}", damage.display());
    let mut entry = String::new();
    for line in fs::read_to_string(source.join("lib.rs")).unwrap().lines() {
        if line.starts_with("//!") {
            entry.push_str(&line.replacen("//!", "//", 1));
        } else {
            if let Some(module) = line.strip_prefix("pub mod ").or_else(|| line.strip_prefix("mod "))
                .and_then(|value| value.strip_suffix(';')) {
                let path = if module == "dom" || module == "css" { output.join(format!("{module}.rs")) } else { source.join(format!("{module}.rs")) };
                entry.push_str(&format!("#[path = {:?}]\n", path.to_str().unwrap()));
            }
            entry.push_str(line);
        }
        entry.push('\n');
    }
    fs::write(output.join("layout.rs"), entry).unwrap();
    println!("cargo:rerun-if-changed={}", source.display());
}
