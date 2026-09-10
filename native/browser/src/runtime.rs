use crate::bridge::ObscuraState;
use rquickjs::{Array, Context, Ctx, Exception, Function, IntoJs, JsLifetime, Object, Persistent, Promise, Runtime, TypedArray, Value, context::EvalOptions, function::{Func, Rest}};
use serde_json::{Value as Json, json};
use std::{cell::{Cell, RefCell}, collections::{BTreeMap, HashMap, VecDeque}, rc::Rc};
use wasm_bindgen::prelude::*;

type Callback = Persistent<Function<'static>>;
struct Timer { callback: Callback, due: f64, posted: bool, background: bool, rendering: bool }
enum Request {
    Stylesheet(u32),
    Script(usize),
    Fetch { resolve: Callback, reject: Callback },
}
struct Script { id: u32, url: Option<String>, module: bool, code: Option<String> }
#[derive(Default)]
struct Loader { styles: usize, scripts: Vec<Script>, index: usize, ready: bool }
#[cfg(feature = "render")]
#[derive(Default)]
struct GeometryValues {
    epoch: u64,
    values: HashMap<u32, Persistent<Value<'static>>>,
}
struct State {
    dom: ObscuraState,
    url: String,
    host: js_sys::Function,
    next_id: Cell<u32>,
    timers: RefCell<BTreeMap<u32, Timer>>,
    pending: RefCell<HashMap<u32, Request>>,
    requests: RefCell<Vec<Json>>,
    loader: RefCell<Loader>,
    errors: RefCell<VecDeque<String>>,
    navigation: RefCell<Option<Json>>,
    fuel: Cell<u32>,
    dom_calls: Cell<u32>,
    host_calls: Cell<u32>,
    steps: Cell<u32>,
    #[cfg(feature = "render")]
    geometry: RefCell<GeometryValues>,
    #[cfg(feature = "trace")]
    trace: crate::trace::Trace,
}
struct Shared(Rc<State>);
// All guest references are Persistent values, explicitly cleared before the context is released.
unsafe impl<'js> JsLifetime<'js> for Shared { type Changed<'to> = Shared; }

fn shared_state(ctx: &Ctx<'_>) -> Rc<State> { ctx.userdata::<Shared>().expect("tab state").0.clone() }
fn thrown(ctx: &Ctx<'_>, message: impl AsRef<str>) -> rquickjs::Error { Exception::throw_message(ctx, message.as_ref()) }
fn error_text(ctx: &Ctx<'_>, error: rquickjs::Error) -> String {
    if error.is_exception() {
        let value = ctx.catch();
        if let Some(exception) = value.as_exception() {
            return format!("{}\n{}", exception.message().unwrap_or_default(), exception.stack().unwrap_or_default());
        }
        return format!("Page exception: {value:?}");
    }
    error.to_string()
}
fn into_value<'js>(ctx: &Ctx<'js>, value: Json) -> rquickjs::Result<Value<'js>> {
    match value {
        Json::Null => Ok(Value::new_null(ctx.clone())),
        Json::Bool(value) => value.into_js(ctx),
        Json::Number(value) => value.as_f64().unwrap_or_default().into_js(ctx),
        Json::String(value) => value.into_js(ctx),
        Json::Array(values) => {
            let array = Array::new(ctx.clone())?;
            for (index, value) in values.into_iter().enumerate() { array.set(index, into_value(ctx, value)?)?; }
            Ok(array.into_value())
        }
        Json::Object(values) => {
            let object = Object::new(ctx.clone())?;
            for (key, value) in values { object.set(key, into_value(ctx, value)?)?; }
            Ok(object.into_value())
        }
    }
}
#[cfg_attr(feature = "trace", tracing::instrument(name = "dom.call", skip_all, fields(command)))]
fn dom_op<'js>(ctx: Ctx<'js>, command: String, a: String, b: String) -> rquickjs::Result<Value<'js>> {
    let state = shared_state(&ctx);
    state.dom_calls.set(state.dom_calls.get() + 1);
    let value = state.dom.value(&command, &a, &b).map_err(|error| thrown(&ctx, error))?;
    // Mutation postconditions in upstream bootstrap are string booleans; other values stay typed.
    if let Json::Bool(value) = value { return value.to_string().into_js(&ctx); }
    into_value(&ctx, value)
}
#[cfg(feature = "render")]
fn layout_geometry<'js>(ctx: Ctx<'js>, id: String) -> rquickjs::Result<Value<'js>> {
    cached_geometry(&ctx, id.parse().unwrap_or(0))
}
#[cfg(feature = "render")]
fn cached_geometry<'js>(ctx: &Ctx<'js>, id: u32) -> rquickjs::Result<Value<'js>> {
    let state = shared_state(ctx);
    let epoch = state.dom.geometry_epoch();
    let mut cache = state.geometry.borrow_mut();
    if cache.epoch != epoch {
        cache.values.clear();
        cache.epoch = epoch;
    }
    if let Some(value) = cache.values.get(&id) { return value.clone().restore(ctx); }
    let value = into_value(ctx, state.dom.geometry(id))?;
    cache.values.insert(id, Persistent::save(ctx, value.clone()));
    Ok(value)
}
#[cfg(feature = "render")]
fn layout_intersections<'js>(ctx: Ctx<'js>, ids: Array<'js>) -> rquickjs::Result<Value<'js>> {
    let result = Array::new(ctx.clone())?;
    for (index, id) in ids.iter::<u32>().enumerate() { result.set(index, cached_geometry(&ctx, id?)?)?; }
    Ok(result.into_value())
}
#[cfg(feature = "render")]
fn layout_metrics<'js>(ctx: Ctx<'js>) -> rquickjs::Result<Value<'js>> {
    into_value(&ctx, shared_state(&ctx).dom.metrics())
}
#[cfg(feature = "render")]
fn scroll_to<'js>(ctx: Ctx<'js>, x: f32, y: f32) -> rquickjs::Result<Value<'js>> {
    into_value(&ctx, shared_state(&ctx).dom.scroll_to(x, y))
}
#[cfg(feature = "render")]
fn scroll_offset<'js>(ctx: Ctx<'js>) -> rquickjs::Result<Value<'js>> {
    into_value(&ctx, shared_state(&ctx).dom.scroll_offset())
}
#[cfg_attr(feature = "trace", tracing::instrument(name = "platform.call", skip_all, fields(name)))]
fn call_host<'js>(ctx: Ctx<'js>, name: String, serialized: String) -> rquickjs::Result<Value<'js>> {
    let state = shared_state(&ctx);
    state.host_calls.set(state.host_calls.get() + 1);
    let result = state.host.call2(&JsValue::NULL, &name.into(), &serialized.into())
        .map_err(|error| thrown(&ctx, error.as_string().unwrap_or_else(|| "Worker host call failed".into())))?;
    ctx.json_parse(result.as_string().ok_or_else(|| thrown(&ctx, "Invalid host response"))?)
}
// Typed buffers keep UTF-8 conversion and its transient allocations inside WASM.
fn text_encode<'js>(ctx: Ctx<'js>, text: String) -> rquickjs::Result<TypedArray<'js, u8>> {
    // QuickJS owns the buffer, so it remains covered by the guest's memory limit.
    TypedArray::new_copy(ctx, text.as_bytes())
}
fn text_decode<'js>(ctx: Ctx<'js>, encoding: String, input: TypedArray<'js, u8>, fatal: bool, ignore_bom: bool) -> rquickjs::Result<Value<'js>> {
    if encoding != "utf-8" {
        let args = Array::new(ctx.clone())?;
        args.set(0, encoding)?; args.set(1, input)?; args.set(2, fatal)?; args.set(3, ignore_bom)?;
        let serialized = ctx.json_stringify(args)?.unwrap().to_string()?;
        let result = call_host(ctx.clone(), "op_text_decode".into(), serialized)?;
        return ctx.json_parse(result.as_string().ok_or_else(|| thrown(&ctx, "Invalid decoder response"))?.to_string()?);
    }
    let bytes = input.as_bytes().ok_or_else(|| thrown(&ctx, "Detached decoder input"))?;
    let bytes = if !ignore_bom { bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes) } else { bytes };
    let result = Object::new(ctx.clone())?;
    if fatal && std::str::from_utf8(bytes).is_err() { result.set("ok", false)?; }
    else { result.set("ok", true)?; result.set("v", String::from_utf8_lossy(bytes).as_ref())?; }
    Ok(result.into_value())
}
fn fetch_url<'js>(ctx: Ctx<'js>, Rest(args): Rest<Value<'js>>) -> rquickjs::Result<Promise<'js>> {
    let state = shared_state(&ctx);
    let array = Array::new(ctx.clone())?;
    for (index, value) in args.into_iter().enumerate() { array.set(index, value)?; }
    let args: Json = serde_json::from_str(&ctx.json_stringify(array)?.unwrap().to_string()?)
        .map_err(|error| thrown(&ctx, error.to_string()))?;
    let (promise, resolve, reject) = Promise::new(&ctx)?;
    state.request(Request::Fetch { resolve: Persistent::save(&ctx, resolve), reject: Persistent::save(&ctx, reject) }, json!({"args": args}));
    Ok(promise)
}
fn user_timer(ctx: Ctx<'_>, _depth: Value<'_>, kind: Value<'_>, delay: f64, callback: Function<'_>) -> rquickjs::Result<u32> {
    let rendering = kind.as_string().is_some_and(|kind| kind.to_string().is_ok_and(|kind| kind == "rendering"));
    timer(&ctx, callback, delay, false, kind.as_bool().unwrap_or(false) || rendering, rendering)
}
fn posted_task(ctx: Ctx<'_>, _priority: Value<'_>, callback: Function<'_>) -> rquickjs::Result<u32> {
    timer(&ctx, callback, 0.0, true, false, false)
}
fn timer(ctx: &Ctx<'_>, callback: Function<'_>, delay: f64, posted: bool, background: bool, rendering: bool) -> rquickjs::Result<u32> {
    let state = shared_state(ctx);
    let id = state.id();
    let due = js_sys::Date::now() + delay.max(0.0);
    #[cfg(feature = "trace")]
    state.trace.flow("task", id, "s", json!({"delay":delay,"due":due,"posted":posted,"background":background,"rendering":rendering,"stack":ctx.eval::<String,_>("new Error().stack").unwrap_or_default()}));
    state.timers.borrow_mut().insert(id, Timer { callback: Persistent::save(callback.ctx(), callback.clone()), due, posted, background, rendering });
    Ok(id)
}

impl State {
    fn id(&self) -> u32 { let id = self.next_id.get() + 1; self.next_id.set(id); id }
    fn request(&self, kind: Request, mut request: Json) {
        let id = self.id(); request["id"] = json!(id);
        #[cfg(feature = "trace")]
        self.trace.flow("request", id, "s", json!({"url":request.get("url").or_else(||request.get("args").and_then(|args|args.get(0)))}));
        self.pending.borrow_mut().insert(id, kind);
        self.requests.borrow_mut().push(request);
    }
    fn record(&self, error: impl AsRef<str>) {
        let mut errors = self.errors.borrow_mut();
        errors.push_back(error.as_ref().chars().take(1500).collect());
        if errors.len() > 20 { errors.pop_front(); }
    }
    fn attribute(&self, id: u32, name: &str) -> Option<String> {
        self.dom.value("get_attribute", &id.to_string(), name).ok()?.as_str().map(str::to_owned)
    }
    fn resolve(&self, url: &str) -> String { url::Url::parse(&self.url).unwrap().join(url).map(|url| url.to_string()).unwrap_or_default() }
}

/// A tab owns its DOM, layout, QuickJS runtime, timers, script loader and guest promises.
#[wasm_bindgen]
pub struct BrowserTab {
    state: Rc<State>,
    context: Context,
    runtime: Runtime,
}

impl BrowserTab {
    #[cfg_attr(feature = "trace", tracing::instrument(name = "quickjs.eval", skip_all, fields(filename)))]
    fn run(&self, source: &str, filename: &str, module: bool) -> Result<(), String> {
        self.state.fuel.set(20_000);
        self.context.with(|ctx| {
            let mut options = EvalOptions::default();
            options.strict = false; options.global = !module; options.filename = Some(filename.into());
            ctx.eval_with_options::<(), _>(source, options).map_err(|error| error_text(&ctx, error))
        })
    }
    #[cfg_attr(feature = "trace", tracing::instrument(name = "scripts.advance", skip_all))]
    fn advance_loader(&self) -> Result<(), String> {
        loop {
            // Browser script tasks have a microtask checkpoint before the next script.
            // Let step drain it and yield if a long promise chain needs another turn.
            if self.runtime.is_job_pending() { return Ok(()); }
            let script = {
                let mut loader = self.state.loader.borrow_mut();
                if loader.ready { return Ok(()); }
                let index = loader.index;
                if loader.styles != 0 { return Ok(()); }
                if index == loader.scripts.len() { loader.ready = true; None }
                else if let Some(code) = loader.scripts[index].code.take() {
                    let script = &loader.scripts[index];
                    let result = (script.id, script.url.clone().unwrap_or_else(|| self.state.url.clone()), script.module, code);
                    loader.index += 1;
                    Some(result)
                } else { return Ok(()); }
            };
            let Some((id, url, module, code)) = script else {
                self.run("__currentScriptNid=0;__documentReadyState__='interactive';document.dispatchEvent(new Event('DOMContentLoaded'));__documentReadyState__='complete';dispatchEvent(new Event('load'))", "document-ready.js", false)?;
                return Ok(());
            };
            self.run(&format!("__currentScriptNid={id}"), "script-start.js", false)?;
            if let Err(error) = self.run(&code, &url, module) { self.state.record(error); }
            if self.state.fuel.get() == 0 { return Err("Page exceeded its JavaScript instruction budget".into()); }
            self.run("__currentScriptNid=0", "script-end.js", false)?;
        }
    }
}

#[wasm_bindgen]
impl BrowserTab {
    #[wasm_bindgen(constructor)]
    pub fn new(html: &str, url: String, host: js_sys::Function) -> Result<BrowserTab, JsError> {
        #[cfg(feature = "trace")]
        let trace = crate::trace::Trace::default();
        #[cfg(feature = "trace")]
        let _tracing = trace.enter();
        #[cfg(feature = "trace")]
        let _span = tracing::info_span!("browser.new").entered();
        let state = Rc::new(State {
            dom: ObscuraState::new(html, url.clone()), url, host, next_id: Cell::new(0), timers: RefCell::default(),
            pending: RefCell::default(), requests: RefCell::default(), loader: RefCell::default(),
            errors: RefCell::default(), navigation: RefCell::default(), fuel: Cell::new(20_000),
            dom_calls: Cell::new(0), host_calls: Cell::new(0), steps: Cell::new(0),
            #[cfg(feature = "render")]
            geometry: RefCell::default(),
            #[cfg(feature = "trace")]
            trace,
        });
        let runtime = Runtime::new().map_err(|error| JsError::new(&error.to_string()))?;
        runtime.set_max_stack_size(256 * 1024);
        let budget = state.clone();
        runtime.set_interrupt_handler(Some(Box::new(move || {
            let fuel = budget.fuel.get().saturating_sub(1); budget.fuel.set(fuel); fuel == 0
        })));
        let context = Context::full(&runtime).map_err(|error| JsError::new(&error.to_string()))?;
        context.with(|ctx| -> rquickjs::Result<()> {
            ctx.store_userdata(Shared(state.clone())).ok().expect("new tab userdata");
            let core = Object::new(ctx.clone())?;
            let ops = Object::new(ctx.clone())?;
            ops.set("op_dom", Func::from(dom_op))?;
            ops.set("op_fetch_url", Func::from(fetch_url))?;
            ops.set("op_posted_task", Func::from(posted_task))?;
            ops.set("__host", Func::from(call_host))?;
            ops.set("op_text_decode", Func::from(text_decode))?;
            ops.set("op_text_encode", Func::from(text_encode))?;
            core.set("queueUserTimer", Func::from(user_timer))?;
            core.set("cancelTimer", Func::from(|ctx: Ctx, id: u32| { shared_state(&ctx).timers.borrow_mut().remove(&id); }))?;
            for name in ["setUnhandledPromiseRejectionHandler", "setHandledPromiseRejectionHandler"] {
                core.set(name, Func::from(|| ()))?;
            }
            #[cfg(feature = "render")]
            {
            ops.set("op_layout_geometry", Func::from(layout_geometry))?;
            ops.set("op_intersection_observer_measurements", Func::from(layout_intersections))?;
            ops.set("op_layout_metrics", Func::from(layout_metrics))?;
            ops.set("op_scroll_to", Func::from(scroll_to))?;
            ops.set("op_scroll_offset", Func::from(scroll_offset))?;
            }
            for name in ["op_script_mark_started", "op_script_try_start"] {
                ops.set(name, Func::from(|ctx: Ctx, id: u32| shared_state(&ctx).dom.script_start(id)))?;
            }
            ops.set("op_shadow_attach", Func::from(|ctx: Ctx, id: u32, mode: String| shared_state(&ctx).dom.shadow_attach(id, &mode)))?;
            ops.set("op_shadow_root_info", Func::from(|ctx: Ctx, id: u32| shared_state(&ctx).dom.shadow_info(id)))?;
            ops.set("op_runtime_events_enabled", Func::from(|| false))?;
            ops.set("op_async_runtime_available", Func::from(|| true))?;
            ops.set("op_posted_task_generation", Func::from(|| 0))?;
            ops.set("op_console_msg", Func::from(|ctx: Ctx, level: String, message: String| shared_state(&ctx).record(format!("{level}: {message}"))))?;
            ops.set("op_navigate", Func::from(|ctx: Ctx, url: String, method: String, body: String| {
                *shared_state(&ctx).navigation.borrow_mut() = Some(json!({"url":url,"method":method,"body":body}));
            }))?;
            core.set("ops", ops)?;
            let deno = Object::new(ctx.clone())?; deno.set("core", core)?; ctx.globals().set("Deno", deno)?;
            Ok(())
        }).map_err(|error| JsError::new(&error.to_string()))?;
        Ok(BrowserTab { state, context, runtime })
    }
    pub fn start(&self, user_agent: &str) -> Result<(), JsError> {
        #[cfg(feature = "trace")]
        let _tracing = self.state.trace.enter();
        #[cfg(feature = "trace")]
        let _span = tracing::info_span!("browser.start").entered();
        self.begin();
        self.run("delete globalThis.performance", "browser-intrinsics.js", false).map_err(|error| JsError::new(&error))?;
        self.run(&format!("((Deno)=>{{{}}})(globalThis.Deno)", include_str!("../js/platform.js").split("globalThis.Intl").next().unwrap()), "platform-ops.js", false).map_err(|error| JsError::new(&error))?;
        self.run(include_str!(concat!(env!("OUT_DIR"), "/bootstrap.js")), "obscura-bootstrap.js", false).map_err(|error| JsError::new(&error))?;
        self.run("__documentReadyState__='loading'", "document-loading.js", false).map_err(|error| JsError::new(&error))?;
        self.run(&format!("__obscura_stealth={};__obscura_ua={};Object.defineProperties(globalThis,{{__obscura_viewport_w:{{value:1280,writable:true,configurable:true}},__obscura_viewport_h:{{value:720,writable:true,configurable:true}}}});__obscura_init()", cfg!(feature = "stealth"), json!(user_agent)), "stealth.js", false).map_err(|error| JsError::new(&error))?;
        self.run(&format!("((Deno)=>{{{}}})(globalThis.Deno);delete globalThis.Deno", include_str!("../js/platform.js")), "platform.js", false).map_err(|error| JsError::new(&error))?;
        let styles = self.state.dom.value("query_selector_all", "link[rel~=\"stylesheet\"]", "").unwrap();
        for id in styles.as_array().unwrap().iter().filter_map(Json::as_u64) {
            if let Some(href) = self.state.attribute(id as u32, "href") {
                self.state.loader.borrow_mut().styles += 1;
                self.state.request(Request::Stylesheet(id as u32), json!({"url":self.state.resolve(&href)}));
            }
        }
        let ids = self.state.dom.value("query_selector_all", "script", "").unwrap();
        self.run(&format!("__markParserScripts({ids})"), "parser-scripts.js", false).map_err(|error| JsError::new(&error))?;
        for id in ids.as_array().unwrap().iter().filter_map(Json::as_u64) {
            let id = id as u32;
            let kind = self.state.attribute(id, "type").unwrap_or_default();
            if self.state.attribute(id, "nomodule").is_some() || !["", "text/javascript", "application/javascript", "module"].contains(&kind.as_str()) { continue; }
            let url = self.state.attribute(id, "src").map(|url| self.state.resolve(&url));
            let code = if url.is_some() { None } else { self.state.dom.value("text_content", &id.to_string(), "").ok().and_then(|value| value.as_str().map(str::to_owned)) };
            let index = self.state.loader.borrow().scripts.len();
            self.state.loader.borrow_mut().scripts.push(Script { id, url: url.clone(), module: kind == "module", code });
            // Discovery queues every parser resource immediately. Download concurrency
            // belongs to the host queue, independently of script execution order.
            if let Some(url) = url { self.state.request(Request::Script(index), json!({"url":url})); }
        }
        self.advance_loader().map_err(|error| JsError::new(&error))
    }
    pub fn requests(&self) -> String { json!(self.state.requests.take()).to_string() }
    pub fn respond(&self, id: u32, metadata: &str, body: &str, error: bool) -> Result<(), JsError> {
        #[cfg(feature = "trace")]
        let _tracing = self.state.trace.enter();
        #[cfg(feature = "trace")]
        let _span = tracing::info_span!("browser.respond", id).entered();
        let request = self.state.pending.borrow_mut().remove(&id);
        let Some(request) = request else { return Ok(()); };
        #[cfg(feature = "trace")]
        self.state.trace.flow("request", id, "f", json!({"error":error}));
        match request {
            Request::Fetch { resolve, reject } => {
                self.state.fuel.set(20_000);
                self.context.with(|ctx| {
                    let result = (|| -> rquickjs::Result<()> {
                        if error {
                            reject.restore(&ctx)?.call((Exception::from_message(ctx.clone(), body)?,))
                        } else {
                            let response = ctx.json_parse(metadata)?.into_object().ok_or_else(|| thrown(&ctx, "Invalid response metadata"))?;
                            response.set("body", body)?;
                            resolve.restore(&ctx)?.call((response,))
                        }
                    })();
                    result.map_err(|error| error_text(&ctx, error))
                }).map_err(|error| JsError::new(&error))?;
            }
            resource => {
                let result = if error { Err(body.to_owned()) } else {
                    serde_json::from_str::<Json>(metadata).map_err(|error| error.to_string()).and_then(|value| {
                        let status = value["status"].as_u64().unwrap_or(0);
                        if !(200..300).contains(&status) { Err(format!("Resource HTTP {status}")) }
                        else { Ok(body.to_owned()) }
                    })
                };
                if let Err(error) = &result { self.state.record(error); }
                let code = result.unwrap_or_default();
                match resource {
                    Request::Script(index) => self.state.loader.borrow_mut().scripts[index].code = Some(code),
                    Request::Stylesheet(id) => {
                        self.state.loader.borrow_mut().styles -= 1;
                        let source = format!("(()=>{{const link=_wrap({id});const style=document.createElement('style');style.setAttribute('data-obscura-external-stylesheets','');style.textContent={};const media=link.getAttribute('media');if(media)style.setAttribute('media',media);__obscura_registerLinkedStylesheet(link,style);if(!link.disabled)link.parentNode.insertBefore(style,link.nextSibling)}})()", json!(code));
                        if let Err(error) = self.run(&source, "linked-stylesheet.js", false) { self.state.record(error); }
                    }
                    _ => unreachable!(),
                }
            }
        }
        Ok(())
    }
    pub fn step(&self) -> Result<String, JsError> {
        #[cfg(feature = "trace")]
        let _tracing = self.state.trace.enter();
        #[cfg(feature = "trace")]
        let _span = tracing::info_span!("browser.step").entered();
        self.state.steps.set(self.state.steps.get() + 1);
        self.state.fuel.set(20_000);
        self.advance_loader().map_err(|error| JsError::new(&error))?;
        let mut ran = false;
        for _ in 0..256 {
            match self.runtime.execute_pending_job() {
                Ok(false) => break,
                Ok(true) => ran = true,
                Err(error) => { self.state.record(error.0.with(|ctx| error_text(&ctx, rquickjs::Error::Exception))); break; }
            }
        }
        self.advance_loader().map_err(|error| JsError::new(&error))?;
        let now = js_sys::Date::now();
        // Each timer is a task with a microtask checkpoint before the next timer.
        let render_ready = self.state.loader.borrow().ready;
        // Headless rendering follows ready application tasks, coalescing their DOM
        // mutations before observer measurement. Explicit geometry reads still flush.
        let due = self.state.timers.borrow().iter().filter(|(_, timer)| timer.due <= now && (!timer.rendering || render_ready))
            .min_by(|(a_id, a), (b_id, b)| a.rendering.cmp(&b.rendering).then(a.due.total_cmp(&b.due)).then(a_id.cmp(b_id)))
            .map(|(id, _)| *id);
        if let Some(id) = due.filter(|_| !self.runtime.is_job_pending()) {
            let timer = self.state.timers.borrow_mut().remove(&id);
            if let Some(timer) = timer {
                #[cfg(feature = "trace")]
                self.state.trace.flow("task", id, "f", json!({"lateMs":now-timer.due}));
                #[cfg(feature = "trace")]
                let _span = tracing::info_span!("quickjs.task", id, posted = timer.posted, background = timer.background, rendering = timer.rendering).entered();
                ran |= !timer.background;
                self.state.fuel.set(20_000);
                self.context.with(|ctx| {
                    let result = timer.callback.restore(&ctx).and_then(|callback| if timer.posted { callback.call::<_, ()>((0,)) } else { callback.call::<_, ()>(()) });
                    if let Err(error) = result { self.state.record(error_text(&ctx, error)); }
                });
            }
        }
        if self.state.fuel.get() == 0 { return Err(JsError::new("Page exceeded its JavaScript instruction budget")); }
        let next_timer = self.state.timers.borrow().values().filter(|timer| !timer.rendering || render_ready).map(|timer| timer.due).min_by(f64::total_cmp);
        let next_task = self.state.timers.borrow().values().filter(|timer| !timer.background).map(|timer| timer.due).min_by(f64::total_cmp);
        Ok(json!({"ran":ran,"pending":self.state.pending.borrow().len(),"jobs":self.runtime.is_job_pending(),"ready":self.state.loader.borrow().ready,"nextTimer":next_timer,"nextTask":next_task}).to_string())
    }
    pub fn evaluate(&self, expression: &str) -> Result<String, JsError> {
        #[cfg(feature = "trace")]
        let _tracing = self.state.trace.enter();
        #[cfg(feature = "trace")]
        let _span = tracing::info_span!("browser.evaluate").entered();
        self.state.fuel.set(20_000);
        let source = format!("(()=>{{const value=({expression});if(value&&typeof value.then==='function')throw Error('Use a synchronous expression and browser_wait_for for page activity');return JSON.stringify(value)??'null'}})()");
        let result = self.context.with(|ctx| ctx.eval::<String, _>(source).map_err(|error| error_text(&ctx, error))).map_err(|error| JsError::new(&error))?;
        Ok(result)
    }
    pub fn begin(&self) {
        // Interrupt a non-yielding task; completing more tasks never exhausts a page-wide quota.
        self.state.fuel.set(20_000);
        // Share the WASM heap across tabs, preserving space for native DOM/layout allocations.
        let available = (88 * 1024 * 1024usize).saturating_sub(crate::ALLOCATOR.used());
        self.runtime.set_memory_limit(self.runtime.memory_usage().memory_used_size.max(0) as usize + available);
    }
    pub fn snapshot(&self) -> Result<String, JsError> { self.evaluate(include_str!("../js/snapshot.js")) }
    pub fn close(self) {}
    pub fn trace_enabled(&self) -> bool { cfg!(feature = "trace") }
    pub fn take_trace(&self) -> String {
        #[cfg(feature = "trace")]
        { self.state.trace.take() }
        #[cfg(not(feature = "trace"))]
        { "[]".into() }
    }
    pub fn take_navigation(&self) -> String { json!(self.state.navigation.take()).to_string() }
    pub fn status(&self) -> String {
        let usage = self.runtime.memory_usage();
        json!({"url":self.state.url,"domNodes":self.state.dom.nodes(),"errors":*self.state.errors.borrow(),"quickJsUsedBytes":usage.memory_used_size,"rustHeapUsedBytes":crate::ALLOCATOR.used(),"runtime":{"domCalls":self.state.dom_calls.get(),"hostCalls":self.state.host_calls.get(),"steps":self.state.steps.get(),"ready":self.state.loader.borrow().ready,"timers":self.state.timers.borrow().len(),"layout":self.state.dom.layout_stats()},"stealth":{"javascript":cfg!(feature="stealth"),"trackerBlocking":true,"tlsFingerprint":"workers-managed"}}).to_string()
    }
}

impl Drop for BrowserTab {
    fn drop(&mut self) {
        #[cfg(feature = "render")]
        self.state.geometry.borrow_mut().values.clear();
        self.state.timers.borrow_mut().clear();
        self.state.pending.borrow_mut().clear();
        self.context.with(|ctx| { let _ = ctx.remove_userdata::<Shared>(); });
    }
}
