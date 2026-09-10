//! Per-tab instrumented spans, exported as Chrome Trace events for Perfetto.
use serde_json::{Map, Value, json};
use serde::Serialize;
use std::{collections::HashMap, sync::{Arc, Mutex}};
use tracing::{Event, Metadata, Subscriber, field::{Field, Visit}, span::{Attributes, Id, Record}};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = performance, js_name = now)]
    fn now() -> f64;
}

struct Span {
    name: &'static str,
    target: &'static str,
    fields: Map<String, Value>,
    references: usize,
}
#[derive(Serialize)]
struct TimelineEvent {
    name: &'static str,
    cat: &'static str,
    ph: &'static str,
    ts: f64,
    dur: f64,
    pid: u32,
    tid: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<u32>,
    args: Map<String, Value>,
}
#[derive(Default)]
struct State {
    next: u64,
    spans: HashMap<u64, Span>,
    stack: Vec<(u64, f64)>,
    events: Vec<TimelineEvent>,
}

#[derive(Clone, Default)]
pub struct Trace(Arc<Mutex<State>>);

struct Fields<'a>(&'a mut Map<String, Value>);
impl Visit for Fields<'_> {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.0.insert(field.name().into(), json!(format!("{value:?}")));
    }
    fn record_str(&mut self, field: &Field, value: &str) { self.0.insert(field.name().into(), json!(value)); }
    fn record_u64(&mut self, field: &Field, value: u64) { self.0.insert(field.name().into(), json!(value)); }
}

impl Trace {
    pub fn enter(&self) -> tracing::subscriber::DefaultGuard {
        tracing::subscriber::set_default(self.clone())
    }
    pub fn take(&self) -> String { serde_json::to_string(&std::mem::take(&mut self.0.lock().unwrap().events)).unwrap() }
    pub fn flow(&self, name: &'static str, id: u32, phase: &'static str, args: Value) {
        self.0.lock().unwrap().events.push(TimelineEvent {
            name, cat: name, ph: phase, ts: now() * 1000.0, dur: 0.0, pid: 1, tid: 1,
            id: Some(id), args: args.as_object().cloned().unwrap_or_default(),
        });
    }
}

impl Subscriber for Trace {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        metadata.is_span() && metadata.target().starts_with("kitesurf")
    }
    fn new_span(&self, attributes: &Attributes<'_>) -> Id {
        let mut state = self.0.lock().unwrap();
        state.next += 1;
        let id = state.next;
        let mut fields = Map::new();
        attributes.record(&mut Fields(&mut fields));
        state.spans.insert(id, Span { name: attributes.metadata().name(), target: attributes.metadata().target(), fields, references: 1 });
        Id::from_u64(id)
    }
    fn record(&self, id: &Id, values: &Record<'_>) {
        if let Some(span) = self.0.lock().unwrap().spans.get_mut(&id.into_u64()) {
            values.record(&mut Fields(&mut span.fields));
        }
    }
    fn record_follows_from(&self, _id: &Id, _follows: &Id) {}
    fn event(&self, _event: &Event<'_>) {}
    fn enter(&self, id: &Id) { self.0.lock().unwrap().stack.push((id.into_u64(), now() * 1000.0)); }
    fn exit(&self, id: &Id) {
        let end = now() * 1000.0;
        let mut state = self.0.lock().unwrap();
        let Some((active, start)) = state.stack.pop() else { return; };
        assert_eq!(active, id.into_u64());
        let span = &state.spans[&active];
        let event = TimelineEvent { name: span.name, cat: span.target, ph: "X", ts: start, dur: end - start, pid: 1, tid: 1, id: None, args: span.fields.clone() };
        state.events.push(event);
    }
    fn clone_span(&self, id: &Id) -> Id {
        self.0.lock().unwrap().spans.get_mut(&id.into_u64()).unwrap().references += 1;
        id.clone()
    }
    fn try_close(&self, id: Id) -> bool {
        let mut state = self.0.lock().unwrap();
        let span = state.spans.get_mut(&id.into_u64()).unwrap();
        span.references -= 1;
        if span.references > 0 { return false; }
        state.spans.remove(&id.into_u64());
        true
    }
}
