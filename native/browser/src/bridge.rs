//! Native DOM callbacks used by Obscura's browser API bootstrap.
//! Parsing, selectors and tree mutations belong to the pinned obscura-dom crate.
//! This adapter holds page state and translates that protocol to the crate API.

use html5ever::{LocalName, Namespace, Prefix, QualName, ns};
use obscura_dom::{DomTree, NodeData, NodeId, ShadowRootMode};
use serde_json::{Value, json};
use std::cell::RefCell;
#[cfg(feature = "render")]
use std::cell::Cell;
use std::collections::HashSet;

// This parser is not exported by obscura-dom. Compile the pinned upstream module.
#[path = "../../../vendor/obscura/crates/obscura-js/src/write_stream.rs"]
mod write_stream;
use write_stream::DocumentWriteStream;
#[path = "layout.rs"]
#[cfg(feature = "render")]
mod layout;
#[cfg(not(feature = "render"))]
mod layout { pub(super) type LayoutCache = (); }

pub struct ObscuraState {
    tree: DomTree,
    url: String,
    started: RefCell<HashSet<NodeId>>,
    writes: RefCell<Option<DocumentWriteStream>>,
    layout: RefCell<Option<layout::LayoutCache>>,
    #[cfg(feature = "render")]
    scroll: Cell<(f32, f32)>,
    #[cfg(feature = "render")]
    layout_count: Cell<u32>,
    #[cfg(feature = "render")]
    layout_millis: Cell<f64>,
    #[cfg(feature = "render")]
    geometry_epoch: Cell<u64>,
    #[cfg(feature = "render")]
    styles: RefCell<obscura_render::LayoutState>,
}

fn node(value: &str) -> NodeId {
    NodeId::new(value.parse().unwrap_or(u32::MAX))
}
fn reference(value: Option<NodeId>) -> Value {
    json!(value.map_or(-1, |id| id.raw() as i64))
}
fn references(values: Vec<NodeId>) -> Value {
    json!(values.into_iter().map(NodeId::raw).collect::<Vec<_>>())
}
fn qualified(namespace: &str, name: &str) -> QualName {
    let (prefix, local) = name.split_once(':')
        .map_or((None, name), |(prefix, local)| (Some(Prefix::from(prefix)), local));
    QualName::new(prefix, Namespace::from(namespace), LocalName::from(local))
}

impl ObscuraState {
    fn attribute(&self, id: NodeId, name: &str) -> Option<String> {
        self.tree.with_node(id, |n| n.get_attribute(name).map(str::to_owned)).flatten()
    }
    fn root(&self, id: NodeId) -> NodeId {
        self.tree.ancestors(id).last().copied().unwrap_or(id)
    }
    fn index(&self, id: NodeId) -> usize {
        self.tree.with_node(id, |n| n.parent).flatten()
            .and_then(|parent| self.tree.children(parent).iter().position(|child| *child == id))
            .unwrap_or(0)
    }
    fn subtree(&self, root: NodeId) -> Vec<NodeId> {
        let mut pending = vec![root];
        let mut nodes = Vec::new();
        while let Some(id) = pending.pop() {
            pending.extend(self.tree.children(id));
            if let Some(contents) = self.tree.with_node(id, |n| match n.data {
                NodeData::Element { template_contents, .. } => template_contents,
                _ => None,
            }).flatten() {
                pending.push(contents);
            }
            nodes.push(id);
        }
        nodes
    }
    fn inert_scripts(&self, root: NodeId) {
        let scripts = self.subtree(root).into_iter().filter(|id| {
            self.tree.with_node(*id, |n| n.as_element().is_some_and(|name| name.local.as_ref() == "script"))
                .unwrap_or(false)
        });
        self.started.borrow_mut().extend(scripts);
    }
    fn order(&self, a: NodeId, b: NodeId) -> i32 {
        if a == b { return 0; }
        let root = self.root(a);
        if root != self.root(b) { return if a.raw() < b.raw() { -1 } else { 1 }; }
        let mut current = Some(root);
        while let Some(id) = current {
            if id == a { return -1; }
            if id == b { return 1; }
            current = self.tree.next_in_subtree(root, id);
        }
        0
    }
}

impl ObscuraState {
    pub fn new(html: &str, url: String) -> Self {
        console_error_panic_hook::set_once();
        Self {
            tree: obscura_dom::parse_html(html), url, started: RefCell::default(), writes: RefCell::default(),
            layout: RefCell::default(),
            #[cfg(feature = "render")]
            scroll: Cell::new((0.0, 0.0)),
            #[cfg(feature = "render")]
            layout_count: Cell::new(0),
            #[cfg(feature = "render")]
            layout_millis: Cell::new(0.0),
            #[cfg(feature = "render")]
            geometry_epoch: Cell::new(0),
            #[cfg(feature = "render")]
            styles: RefCell::default(),
        }
    }
    pub fn nodes(&self) -> usize { self.tree.len() }
    pub fn layout_stats(&self) -> Value {
        #[cfg(feature = "render")]
        { json!({"count":self.layout_count.get(),"milliseconds":self.layout_millis.get()}) }
        #[cfg(not(feature = "render"))]
        { Value::Null }
    }
    pub fn script_start(&self, id: u32) -> bool { self.started.borrow_mut().insert(NodeId::new(id)) }
    pub fn shadow_attach(&self, id: u32, mode: &str) -> i32 {
        self.layout.borrow_mut().take();
        #[cfg(feature = "render")]
        self.styles.borrow_mut().invalidate(None);
        #[cfg(feature = "render")]
        self.geometry_epoch.set(self.geometry_epoch.get() + 1);
        let mode = if mode == "open" { ShadowRootMode::Open } else { ShadowRootMode::Closed };
        self.tree.attach_shadow_root(NodeId::new(id), mode).map_or(-1, |root| root.raw() as i32)
    }
    pub fn shadow_info(&self, id: u32) -> String {
        self.tree.shadow_root(NodeId::new(id)).and_then(|root| self.tree.shadow_root_info(root))
            .map(|info| format!("{}\0{}", info.id.raw(), if info.mode == ShadowRootMode::Open { "open" } else { "closed" }))
            .unwrap_or_default()
    }

}

impl ObscuraState {
    pub fn value(&self, command: &str, first: &str, second: &str) -> Result<Value, String> {
        let dom = &self.tree;
        let id = node(first);
        let other = node(second);
        let affects_layout = match command {
            "document_write" => true,
            "append_child" | "insert_before" => dom.is_connected(id) || dom.is_connected(other),
            _ => (command.starts_with("set_") || command.starts_with("remove_")) && dom.is_connected(id),
        };
        #[cfg(feature = "render")]
        let mutation = if affects_layout { self.style_mutation(command, id, other, second) } else { None };
        let value = match command {
            "document_node_id" => reference(Some(dom.document())),
            "document_url" => json!(self.url),
            "document_referrer" => json!(""),
            "document_encoding" => json!("UTF-8"),
            "document_title" => json!(dom.query_selector("title").ok().flatten()
                .map(|id| dom.text_content(id).split_ascii_whitespace().collect::<Vec<_>>().join(" "))
                .unwrap_or_default()),
            "document_element" => reference(dom.query_selector("html").ok().flatten()),
            "document_base_href" | "document_base_url" => {
                let href = dom.query_selector("base[href]").ok().flatten()
                    .and_then(|id| self.attribute(id, "href")).unwrap_or_default();
                if command == "document_base_href" { json!(href) }
                else { json!(url::Url::parse(&self.url).ok().and_then(|url| url.join(&href).ok())
                    .map_or_else(|| self.url.clone(), |url| url.to_string())) }
            }
            "document_doctype" => dom.children(dom.document()).into_iter().find_map(|id| {
                dom.with_node(id, |n| match &n.data {
                    NodeData::Doctype { name, public_id, system_id } =>
                        Some(json!({"name": name, "publicId": public_id, "systemId": system_id, "nodeId": id.raw()})),
                    _ => None,
                }).flatten()
            }).unwrap_or(Value::Null),
            "get_element_by_id" => {
                let indexed = dom.get_element_by_id(first).filter(|id| dom.is_connected(*id));
                reference(indexed.or_else(|| dom.descendants(dom.document()).into_iter()
                    .find(|id| self.attribute(*id, "id").as_deref() == Some(first))))
            }
            "query_selector" => reference(dom.query_selector(first).ok().flatten()),
            "query_selector_all" => references(dom.query_selector_all(first).unwrap_or_default()),
            "query_selector_scoped" => reference(dom.query_selector_from(id, second).ok().flatten()),
            "query_selector_all_scoped" => references(dom.query_selector_all_from(id, second).unwrap_or_default()),
            "matches_selector" => json!(dom.matches_selector(id, second).unwrap_or(false)),
            "node_type" => json!(dom.with_node(id, |n| match n.data {
                NodeData::Document => 9, NodeData::Element { .. } => 1,
                NodeData::Text { .. } => 3, NodeData::Comment { .. } => 8,
                NodeData::Doctype { .. } => 10, NodeData::ProcessingInstruction { .. } => 7,
            }).unwrap_or(0)),
            "node_name" => json!(dom.with_node(id, |n| match &n.data {
                NodeData::Document => "#document".into(),
                NodeData::Element { name, .. } => name.local.as_ref().to_ascii_uppercase(),
                NodeData::Text { .. } => "#text".into(), NodeData::Comment { .. } => "#comment".into(),
                NodeData::Doctype { name, .. } => name.clone(),
                NodeData::ProcessingInstruction { target, .. } => target.clone(),
            }).unwrap_or_default()),
            "text_content" => json!(dom.text_content(id)),
            "parent_node" | "first_child" | "last_child" | "next_sibling" | "prev_sibling" => reference(dom.with_node(id, |n| match command {
                "parent_node" => n.parent, "first_child" => n.first_child, "last_child" => n.last_child,
                "next_sibling" => n.next_sibling, _ => n.prev_sibling,
            }).flatten()),
            "next_in_subtree" => reference(dom.next_in_subtree(id, other)),
            "prev_in_subtree" => reference(dom.prev_in_subtree(id, other)),
            "next_after_subtree" => reference(dom.next_after_subtree(id, other)),
            "child_nodes" => references(dom.children(id)),
            "element_children" => references(dom.children(id).into_iter()
                .filter(|child| dom.with_node(*child, |n| n.is_element()).unwrap_or(false)).collect()),
            "has_child_nodes" => json!(dom.with_node(id, |n| n.first_child.is_some()).unwrap_or(false)),
            "contains" => json!(id == other || dom.ancestors(other).contains(&id)),
            "is_connected" => json!(dom.is_connected(id)),
            "node_index" => json!(self.index(id)),
            "node_root" => reference(Some(self.root(id))),
            "compare_order" => json!(self.order(id, other)),
            "tag_name" | "local_name" | "namespace_uri" => json!(dom.with_node(id, |n| n.as_element().map(|name| {
                match command {
                    "namespace_uri" => name.ns.to_string(),
                    "local_name" => name.local.to_string(),
                    _ if name.ns == ns!(html) => name.local.as_ref().to_ascii_uppercase(),
                    _ => name.prefix.as_ref().map_or_else(|| name.local.to_string(), |prefix| format!("{}:{}", prefix, name.local)),
                }
            })).flatten().unwrap_or_default()),
            "get_attribute" => json!(self.attribute(id, second)),
            "get_attribute_ns" => {
                let (ns, name) = second.split_once('\0').unwrap_or(("", second));
                json!(dom.with_node(id, |n| n.get_attribute_ns(ns, name).map(str::to_owned)).flatten())
            }
            "attribute_names" => json!(dom.with_node(id, |n| n.attrs()
                .map(|attrs| attrs.iter().map(|attr| attr.qualified_name()).collect::<Vec<_>>())
                .unwrap_or_default()).unwrap_or_default()),
            "set_attribute" | "set_attribute_ns" | "remove_attribute" | "remove_attribute_ns" => {
                if command == "set_attribute" {
                    if let Some((name, value)) = second.split_once('\0') {
                        if self.attribute(id, name).as_deref() == Some(value) { return Ok(json!(true)); }
                    }
                }
                if command == "remove_attribute" && self.attribute(id, second).is_none() { return Ok(json!(true)); }
                let old_id = self.attribute(id, "id");
                dom.with_node_mut(id, |n| match command {
                    "set_attribute" => if let Some((name, value)) = second.split_once('\0') { n.set_attribute(name, value.into()); },
                    "set_attribute_ns" => {
                        let mut pieces = second.splitn(3, '\0');
                        if let (Some(ns), Some(name), Some(value)) = (pieces.next(), pieces.next(), pieces.next()) {
                            n.set_attribute_ns(ns, name, value.into());
                        }
                    }
                    "remove_attribute_ns" => { let (ns, name) = second.split_once('\0').unwrap_or(("", second)); n.remove_attribute_ns(ns, name); }
                    _ => if let Some(attrs) = n.attrs_mut() { attrs.retain(|attr| !attr.qualified_name_eq(second)); },
                });
                dom.update_id_index(id, old_id.as_deref(), self.attribute(id, "id").as_deref());
                json!(true)
            }
            "inner_html" => json!(dom.inner_html(id)),
            "outer_html" => json!(dom.outer_html(id)),
            "append_child" | "insert_before" => {
                if dom.get_node(id).is_none() || dom.get_node(other).is_none() { json!(false) }
                else if command == "append_child" {
                    dom.append_child(id, other);
                    json!(dom.with_node(other, |n| n.parent).flatten() == Some(id))
                } else {
                    let parent = dom.with_node(other, |n| n.parent).flatten();
                    dom.insert_before(other, id);
                    json!(parent.is_some() && dom.with_node(id, |n| n.parent).flatten() == parent)
                }
            }
            "remove_child" => {
                let had_parent = dom.with_node(id, |n| n.parent.is_some()).unwrap_or(false);
                dom.remove_child(id);
                json!(had_parent && dom.with_node(id, |n| n.parent.is_none()).unwrap_or(false))
            }
            "set_text_content" => {
                if dom.text_content(id) == second { return Ok(json!(true)); }
                dom.with_node_mut(id, |n| match &mut n.data {
                    NodeData::Text { contents } | NodeData::Comment { contents } => *contents = second.into(),
                    NodeData::ProcessingInstruction { data, .. } => *data = second.into(),
                    _ => (),
                });
                json!(true)
            }
            "set_inner_html" | "set_inner_html_context" | "set_fragment_html_executable" => {
                if id == dom.document() || dom.get_node(id).is_none() { return Ok(json!(false)); }
                let (context, html) = if command == "set_inner_html" {
                    (dom.with_node(id, |n| n.as_element().cloned()).flatten()
                        .unwrap_or_else(|| qualified(ns!(html).as_ref(), "body")), second)
                } else {
                    let mut parts = second.splitn(3, '\0');
                    let (namespace, name, html) = (parts.next(), parts.next(), parts.next());
                    (qualified(namespace.unwrap_or(ns!(html).as_ref()), name.unwrap_or("body")), html.unwrap_or(""))
                };
                for child in dom.children(id) { dom.detach(child); }
                let fragment = obscura_dom::parse_fragment_with_context(html, context);
                dom.import_children_from(id, &fragment, fragment.fragment_root());
                if command != "set_fragment_html_executable" { self.inert_scripts(id); }
                json!(true)
            }
            "document_write" => json!(self.writes.borrow_mut().get_or_insert_with(DocumentWriteStream::new)
                .write(second, dom).into_iter().map(|p| [p.parent.map_or(0, NodeId::raw), p.node.raw()]).collect::<Vec<_>>()),
            "document_write_reset" => { *self.writes.borrow_mut() = None; json!(true) }
            "template_contents" => reference(dom.template_contents(id)),
            "create_document_fragment" => reference(Some(dom.new_node(NodeData::Document))),
            "clone_node" => {
                let cloned = dom.clone_node(id, second == "true");
                if let Some(cloned) = cloned {
                    let flags = self.subtree(id).into_iter().zip(self.subtree(cloned))
                        .filter_map(|(source, copy)| self.started.borrow().contains(&source).then_some(copy)).collect::<Vec<_>>();
                    self.started.borrow_mut().extend(flags);
                }
                reference(cloned)
            }
            "create_element" | "create_element_ns" => {
                let name = if command == "create_element" { qualified(ns!(html).as_ref(), first) }
                    else { let (namespace, name) = first.split_once('\0').unwrap_or(("", first)); qualified(namespace, name) };
                reference(Some(dom.new_node(NodeData::Element {
                    name, attrs: vec![], template_contents: None, mathml_annotation_xml_integration_point: false,
                })))
            }
            "create_text_node" => reference(Some(dom.new_node(NodeData::Text { contents: first.into() }))),
            "create_comment_node" => reference(Some(dom.new_node(NodeData::Comment { contents: first.into() }))),
            "create_processing_instruction" => reference(Some(dom.new_node(NodeData::ProcessingInstruction { target: first.into(), data: second.into() }))),
            "create_doctype" => reference(Some(dom.new_node(NodeData::Doctype { name: first.into(), public_id: second.into(), system_id: String::new() }))),
            "pi_target" | "doctype_name" | "doctype_public_id" => json!(dom.with_node(id, |n| match &n.data {
                NodeData::ProcessingInstruction { target, .. } => target.clone(),
                NodeData::Doctype { name, public_id, .. } => if command == "doctype_name" { name.clone() } else { public_id.clone() },
                _ => String::new(),
            }).unwrap_or_default()),
            _ => return Err(format!("Unsupported DOM operation: {command}")),
        };
        if affects_layout {
            #[cfg(feature = "render")]
            let kept_geometry = self.layout.borrow().is_some() && mutation.as_ref().is_some_and(|mutation| self.styles.borrow().keeps_geometry(mutation));
            #[cfg(not(feature = "render"))]
            let kept_geometry = false;
            #[cfg(feature = "trace")]
            let _span = tracing::info_span!("layout.invalidate", command, node = id.raw(), argument = second.split('\0').next().unwrap_or_default(), kept_geometry).entered();
            if !kept_geometry {
                self.layout.borrow_mut().take();
                #[cfg(feature = "render")]
                self.geometry_epoch.set(self.geometry_epoch.get() + 1);
            }
            #[cfg(feature = "render")]
            self.styles.borrow_mut().invalidate(if kept_geometry { None } else { mutation });
        }
        Ok(value)
    }
}
