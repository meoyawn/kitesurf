use std::{env, fs, path::PathBuf};

fn main() {
    let source = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap())
        .join("../../vendor/obscura/crates/obscura-js/js/bootstrap.js");
    let bootstrap = fs::read_to_string(&source).expect("Run task setup to initialize Obscura");
    // Frameworks use `"Deno" in globalThis` to distinguish server runtimes. The
    // adapter belongs to this closure, not the page's browser environment.
    let prefix = "\"use strict\";\n(function () {\n";
    assert!(bootstrap.starts_with(prefix));
    let bootstrap = bootstrap.replacen(prefix, &format!("{prefix}const Deno = globalThis.Deno;\n"), 1);
    // Native DOM callbacks now return JS values, preserving the bootstrap's mutation bookkeeping.
    let from = "JSON.parse(_dom(cmd, a1, a2))";
    assert_eq!(bootstrap.matches(from).count(), 1);
    let bootstrap = bootstrap.replace(from, "_dom(cmd, a1, a2)");
    let from = "const _s = a.stack || a.message || String(a);";
    assert_eq!(bootstrap.matches(from).count(), 1);
    let bootstrap = bootstrap.replace(from, "const _s = a.stack ? (a.message && !a.stack.includes(a.message) ? a.message + '\\n' : '') + a.stack : a.message || String(a);");
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
    let mut bootstrap = bootstrap.replace(from, "Deno.core.ops.op_text_decode(this.encoding, bytes, this.fatal, this.ignoreBOM)");
    // Fetch responses carry native guest objects and a separate body, with no JSON body round trip.
    let from = "const parsed = JSON.parse(raw);";
    assert_eq!(bootstrap.matches(from).count(), 3);
    bootstrap = bootstrap.replace(from, "const parsed = raw;");
    let from = "const geometry = JSON.parse(raw);";
    assert_eq!(bootstrap.matches(from).count(), 2);
    bootstrap = bootstrap.replace(from, "const geometry = raw;");
    for (from, to) in [
        ("geometry = raw ? JSON.parse(raw) : null;", "geometry = raw;"),
        ("const raw = Deno.core.ops.op_layout_metrics();\n      return raw ? JSON.parse(raw) : null;", "return Deno.core.ops.op_layout_metrics();"),
        ("const raw = Deno.core.ops.op_scroll_offset();\n      return raw ? JSON.parse(raw) : null;", "return Deno.core.ops.op_scroll_offset();"),
        ("const raw = Deno.core.ops.op_scroll_to(+x || 0, +y || 0);\n      return raw ? JSON.parse(raw) : null;", "return Deno.core.ops.op_scroll_to(+x || 0, +y || 0);"),
        ("const raw = bulk(JSON.stringify(nativeElements.map(element => element._nid | 0)));\n    const geometries = raw ? JSON.parse(raw) : null;", "const geometries = bulk(nativeElements.map(element => element._nid | 0));"),
    ] {
        assert_eq!(bootstrap.matches(from).count(), 1, "{from}");
        bootstrap = bootstrap.replace(from, to);
    }
    // Non-geometric CSS reads must not force a layout before the dimension
    // fallback decides it has no value to supply for that property.
    let from = "  const dimensionFor = (name) => {\n    try {";
    assert_eq!(bootstrap.matches(from).count(), 1);
    bootstrap = bootstrap.replace(from, "  const dimensionFor = (name) => {\n    switch (name) {\n      case 'width': case 'inline-size': case 'height': case 'block-size':\n      case 'left': case 'top': case 'right': case 'bottom':\n      case 'client-width': case 'offset-width': case 'client-height': case 'offset-height': break;\n      default: return null;\n    }\n    try {");
    // A pending reader.closed promise is passive. Polling it with zero-delay timers keeps
    // framework streams permanently busy and prevents an otherwise loaded page from settling.
    for (from, to) in [
        ("      this._reads = [];", "      this._reads = [];\n      this._closedReaders = [];"),
        ("          stream._state = \"closed\";\n          while (stream._reads.length)", "          stream._state = \"closed\";\n          for (const reader of stream._closedReaders.splice(0)) reader.resolve();\n          while (stream._reads.length)"),
        ("          while (stream._reads.length) stream._reads.shift().reject(error);", "          while (stream._reads.length) stream._reads.shift().reject(error);\n          for (const reader of stream._closedReaders.splice(0)) reader.reject(error);"),
        (r#"          return new Promise((resolve, reject) => {
            const poll = () => {
              if (stream._state === "closed") resolve();
              else if (stream._state === "errored") reject(stream._error);
              else setTimeout(poll, 0);
            };
            poll();
          });"#, "          return new Promise((resolve, reject) => stream._closedReaders.push({resolve, reject}));"),
    ] {
        assert_eq!(bootstrap.matches(from).count(), 1, "{from}");
        bootstrap = bootstrap.replace(from, to);
    }
    // Recurring background callbacks still run, but do not prolong automatic action settling.
    for (from, to) in [
        ("const _scheduleAfter = (delay, fn) => {", "const _scheduleAfter = (delay, fn, background = false) => {"),
        ("Deno.core.queueUserTimer(0, false, d, () => {", "Deno.core.queueUserTimer(0, background, d, () => {"),
        ("_scheduleAfter(nextDelay, tick)", "_scheduleAfter(nextDelay, tick, true)"),
        ("    tick,\n  );", "    tick,\n    true,\n  );"),
        ("_scheduleAfter(_RAF_FRAME_DELAY_MS, _runRenderingOpportunity)", "_scheduleAfter(_RAF_FRAME_DELAY_MS, _runRenderingOpportunity, 'rendering')"),
        ("'Dynamic script error (' + task.url + '):', e.message", "'Dynamic script error (' + task.url + '):', e?.message || String(e)"),
    ] {
        assert_eq!(bootstrap.matches(from).count(), 1, "{from}");
        bootstrap = bootstrap.replace(from, to);
    }
    fs::write(PathBuf::from(env::var("OUT_DIR").unwrap()).join("bootstrap.js"), bootstrap).unwrap();
    println!("cargo:rerun-if-changed={}", source.display());
}
