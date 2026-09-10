for (const name of ["op_get_cookies", "op_set_cookie", "op_random_bytes", "op_encoding_for_label", "op_url_resolve", "op_url_parse", "op_url_set", "op_intl"]) {
  Deno.core.ops[name] = (...args) => Deno.core.ops.__host(name, JSON.stringify(args));
}
globalThis.Intl = {};
for (const kind of ["PluralRules", "NumberFormat", "DateTimeFormat", "Collator", "RelativeTimeFormat", "ListFormat", "DisplayNames"]) {
  Intl[kind] = function (...args) {
    for (const method of ["select", "selectRange", "format", "formatToParts", "compare", "resolvedOptions", "formatRange", "formatRangeToParts", "of"]) {
      this[method] = (...params) => JSON.parse(Deno.core.ops.op_intl(kind, JSON.stringify(args), method, JSON.stringify(params)));
    }
  };
  Intl[kind].supportedLocalesOf = (...params) => JSON.parse(Deno.core.ops.op_intl(kind, "[]", "supportedLocalesOf", JSON.stringify(params)));
}
