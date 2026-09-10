#[cfg(feature = "paint")]
compile_error!("The Worker adapter supports layout only");

include!(concat!(env!("OUT_DIR"), "/layout.rs"));

pub type CustomProperties = im_rc::HashMap<String, String>;

/// Move computed styles between layouts. The upstream invalidation planner refreshes
/// affected selectors and inherited subtrees and falls back when CSS changes.
#[derive(Default)]
pub struct LayoutState {
    stylesheets: StylesheetCache,
    retained: Option<dom::RetainedStyleMaps>,
    mutations: Vec<RetainedStyleMutation>,
    shadow_styles: Vec<std::sync::Arc<css::Stylesheet>>,
}

impl LayoutState {
    pub fn keeps_geometry(&self, mutation: &RetainedStyleMutation) -> bool {
        let RetainedStyleMutation::Attribute(attribute) = mutation else { return false; };
        let name = attribute.name.to_ascii_lowercase();
        self.stylesheets.attribute_keeps_geometry(&name) && self.shadow_styles.iter().all(|sheet| sheet.attribute_keeps_geometry(&name))
    }

    pub fn invalidate(&mut self, mutation: Option<RetainedStyleMutation>) {
        if let Some(mutation) = mutation {
            if self.retained.is_some() { self.mutations.push(mutation); }
        } else {
            self.retained = None;
            self.mutations.clear();
        }
    }

    pub fn layout(&mut self, tree: &obscura_dom::DomTree, viewport: (f32, f32)) -> DomLayout {
        self.shadow_styles = dom::collect_shadow_stylesheets(tree, viewport, crate::CssMediaType::Screen).into_values().collect();
        let intrinsic = std::collections::HashMap::new();
        let result = if let Some(retained) = self.retained.take() {
            dom::layout_dom_with_web_fonts_and_retained_styles(tree, viewport, &intrinsic, &[], &mut self.stylesheets, retained, &self.mutations)
        } else {
            dom::layout_dom_with_web_fonts_and_stylesheet_cache(tree, viewport, &intrinsic, &[], &mut self.stylesheets)
        };
        self.mutations.clear();
        result
    }

    pub fn retain(&mut self, layout: &mut DomLayout) {
        self.retained = Some(dom::RetainedStyleMaps {
            styles: std::mem::take(&mut layout.styles),
            custom_properties: std::mem::take(&mut layout.custom_properties),
        });
    }
}
