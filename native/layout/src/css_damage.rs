// Included inside the pinned CSS module so damage checks use its compiled rules.
impl StylesheetCache {
    pub(crate) fn attribute_keeps_geometry(&self, name: &str) -> bool {
        self.entry.as_ref().is_some_and(|entry| entry.sheet.attribute_keeps_geometry(name))
    }
}

impl Stylesheet {
    pub(crate) fn attribute_keeps_geometry(&self, name: &str) -> bool {
        // ARIA and data attributes have no native sizing semantics. Selectors,
        // generated content and custom properties can still make them affect layout.
        if !name.starts_with("aria-") && !name.starts_with("data-") { return false; }
        self.invalidation_map().attribute_dependencies(name).iter().all(|dependency| {
            let mut found = false;
            for rule in &self.rules {
                if rule.order == dependency.rule_order {
                    found = true;
                    if !geometry_neutral_declarations(&rule.normal_decls) || !geometry_neutral_declarations(&rule.important_decls) {
                        return false;
                    }
                }
            }
            // Pseudo-element or otherwise unrepresented rules remain a full fallback.
            found
        })
    }
}

fn geometry_neutral_declarations(css: &str) -> bool {
    crate::style::split_declarations(css).into_iter().filter(|declaration| !declaration.trim().is_empty()).all(|declaration| {
        let Some((name, value)) = declaration.split_once(':') else { return false; };
        match name.trim().to_ascii_lowercase().as_str() {
            "color" | "background-color" | "opacity" => true,
            "visibility" => matches!(value.trim().to_ascii_lowercase().as_str(), "hidden" | "visible"),
            _ => false,
        }
    })
}
