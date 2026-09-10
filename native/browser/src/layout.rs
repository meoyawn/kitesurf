use super::ObscuraState;
use obscura_dom::NodeId;
use obscura_render::{AttributeStyleMutation, Rect, RetainedStyleMutation};
use serde_json::{Value, json};
use std::collections::HashMap;

const VIEWPORT: (f32, f32) = (1280.0, 720.0);

pub(super) struct LayoutCache {
    boxes: HashMap<NodeId, BoxGeometry>,
    size: (f32, f32),
}

struct BoxGeometry {
    rect: Rect,
    client: (f32, f32),
    border: (f32, f32),
    clips: (bool, bool),
    fixed: bool,
}

impl BoxGeometry {
    fn value(&self, scroll: (f32, f32)) -> Value {
        let (sx, sy) = if self.fixed { (0.0, 0.0) } else { scroll };
        let (x, y) = (self.rect.x - sx, self.rect.y - sy);
        json!({
            "x": x, "y": y, "width": self.rect.width, "height": self.rect.height,
            "clientWidth": self.client.0, "clientHeight": self.client.1,
            "borderLeftWidth": self.border.0, "borderTopWidth": self.border.1,
            "overflowX": if self.clips.0 { "hidden" } else { "visible" },
            "overflowY": if self.clips.1 { "hidden" } else { "visible" },
            "viewportFixed": self.fixed,
            "clientRects": [{"x": x, "y": y, "width": self.rect.width, "height": self.rect.height}],
        })
    }
}

impl ObscuraState {
    pub(super) fn style_mutation(&self, command: &str, id: NodeId, _other: NodeId, value: &str) -> Option<RetainedStyleMutation> {
        Some(match command {
            "set_attribute" | "remove_attribute" => {
                let (name, new_value) = if command == "set_attribute" {
                    let (name, value) = value.split_once('\0')?;
                    (name, Some(value.to_owned()))
                } else { (value, None) };
                AttributeStyleMutation { node: id, name: name.into(), old_value: self.attribute(id, name), new_value }.into()
            }
            // A tree rebuild gets a fresh cascade. Expanding sibling scopes for
            // every intermediate mutation is quadratic during framework hydration.
            _ => return None,
        })
    }

    #[cfg_attr(feature = "trace", tracing::instrument(name = "layout.geometry", skip_all))]
    fn with_layout<T>(&self, read: impl FnOnce(&LayoutCache) -> T) -> T {
        let mut cache = self.layout.borrow_mut();
        let layout = cache.get_or_insert_with(|| {
            #[cfg(feature = "trace")]
            let _span = tracing::info_span!("layout.rebuild").entered();
            let started = js_sys::Date::now();
            let mut styles = self.styles.borrow_mut();
            let mut laid = styles.layout(&self.tree, VIEWPORT);
            let size = laid.scrolling_content_size(&self.tree, VIEWPORT);
            let fixed = laid.viewport_fixed_nodes(&self.tree);
            // Keep browser geometry and move computed styles back to the next layout.
            let boxes = laid.rects.iter().map(|(id, rect)| {
                let style = laid.styles.get(id);
                let border = style.map(|style| style.border).unwrap_or_default();
                let (dx, dy) = laid.translates.get(id).copied().unwrap_or_default();
                (*id, BoxGeometry {
                    rect: Rect { x: rect.x + dx, y: rect.y + dy, ..*rect },
                    client: ((rect.width - border.left - border.right).max(0.0), (rect.height - border.top - border.bottom).max(0.0)),
                    border: (border.left, border.top),
                    clips: style.map(|style| (style.overflow_clip_x, style.overflow_clip_y)).unwrap_or_default(),
                    fixed: fixed.contains(id),
                })
            }).collect();
            styles.retain(&mut laid);
            self.layout_count.set(self.layout_count.get() + 1);
            self.layout_millis.set(self.layout_millis.get() + js_sys::Date::now() - started);
            LayoutCache { boxes, size }
        });
        read(layout)
    }
}

impl ObscuraState {
    pub fn geometry_epoch(&self) -> u64 { self.geometry_epoch.get() }
    pub fn geometry(&self, id: u32) -> Value {
        self.with_layout(|layout| {
            layout.boxes.get(&NodeId::new(id)).map(|geometry| geometry.value(self.scroll.get())).unwrap_or(Value::Null)
        })
    }
    pub fn metrics(&self) -> Value {
        self.with_layout(|layout| json!({
            "scrollWidth": layout.size.0, "scrollHeight": layout.size.1,
            "clientWidth": VIEWPORT.0, "clientHeight": VIEWPORT.1,
        }))
    }
    pub fn scroll_to(&self, x: f32, y: f32) -> Value {
        let offset = self.with_layout(|layout| (
            if x.is_finite() { x.clamp(0.0, (layout.size.0 - VIEWPORT.0).max(0.0)) } else { 0.0 },
            if y.is_finite() { y.clamp(0.0, (layout.size.1 - VIEWPORT.1).max(0.0)) } else { 0.0 },
        ));
        if self.scroll.replace(offset) != offset { self.geometry_epoch.set(self.geometry_epoch.get() + 1); }
        json!({"x": offset.0, "y": offset.1})
    }
    pub fn scroll_offset(&self) -> Value {
        let (x, y) = self.scroll.get();
        self.scroll_to(x, y)
    }
}
