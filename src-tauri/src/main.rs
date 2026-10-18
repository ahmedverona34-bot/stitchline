//! Stitchline desktop app: the window (WebView2) shows ../ui; every UI action goes to the
//! Rust engine (stitchline-engine) through two commands. A small script injected before the page loads turns the
//! UI's fetch('/api/<action>') calls into those commands, so the UI works the same as with the Python server.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::sync::Mutex;
use stitchline_engine::session::{app_dir, Dialogs, FileTypes, Session};
use stitchline_engine::Error;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

/// fetch('/api/<op>') -> invoke('api' | 'upload'); '/api/ping' answers at once.
const FETCH_SHIM: &str = r#"
(() => {
  const realFetch = window.fetch.bind(window);
  const reply = (body, status) => new Response(body, { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  const invoke = (cmd, args, options) => window.__TAURI_INTERNALS__.invoke(cmd, args, options);
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const m = url.origin === location.origin && /^\/api\/([A-Za-z0-9_]+)$/.exec(url.pathname);
    if (!m) return realFetch(input, init);
    const op = m[1];
    if (op === 'ping') return reply('{"ok":true}', 200);
    try {
      let buf;
      if (op === 'upload') {
        const h = new Headers(init.headers || {});
        buf = await invoke('upload', new Uint8Array(init.body), { headers: { 'X-File-Name': h.get('X-File-Name') || 'drop.dxf' } });
      } else {
        buf = await invoke('api', { op, args: init.body ? JSON.parse(init.body) : {} });
      }
      return reply(buf, 200);
    } catch (e) {
      const err = e && typeof e === 'object' ? e : { error: String(e), status: 500 };
      return reply(JSON.stringify({ error: err.error || 'Something went wrong.' }), err.status || 500);
    }
  };
})();
"#;

/// The native Open / Save dialogs, on top of the Stitchline window.
struct NativeDialogs {
    app: AppHandle,
}

fn filters(types: FileTypes) -> Vec<(String, Vec<String>)> {
    types
        .iter()
        .map(|(name, pats)| {
            let exts = pats.split_whitespace().map(|p| p.trim_start_matches("*.").to_string()).collect();
            (name.to_string(), exts)
        })
        .collect()
}

impl NativeDialogs {
    fn builder(&self, title: &str, types: FileTypes, initial_dir: &str) -> tauri_plugin_dialog::FileDialogBuilder<tauri::Wry> {
        let mut b = self.app.dialog().file().set_title(title);
        for (name, exts) in filters(types) {
            let e: Vec<&str> = exts.iter().map(String::as_str).collect();
            b = b.add_filter(name, &e);
        }
        let dir = PathBuf::from(initial_dir);
        if dir.is_dir() {
            b = b.set_directory(dir);
        }
        if let Some(w) = self.app.get_webview_window("main") {
            b = b.set_parent(&w);
        }
        b
    }
}

impl Dialogs for NativeDialogs {
    fn ask_open(&self, title: &str, types: FileTypes, initial_dir: &str) -> Option<String> {
        let p = self.builder(title, types, initial_dir).blocking_pick_file()?;
        p.into_path().ok().map(|p| p.to_string_lossy().into_owned())
    }

    fn ask_save(&self, title: &str, _ext: &str, types: FileTypes, name: &str, initial_dir: &str) -> Option<String> {
        let p = self.builder(title, types, initial_dir).set_file_name(name).blocking_save_file()?;
        p.into_path().ok().map(|p| p.to_string_lossy().into_owned())
    }
}

struct App(Mutex<Session>);

fn fail(e: Error) -> Value {
    json!({"error": e.text(), "status": e.status()})
}

/// Run one engine call with the session locked; a crash in the engine becomes an error message, not a dead app.
fn with_session<F: FnOnce(&mut Session) -> Result<Value, Error>>(app: &App, f: F) -> Result<Response, Value> {
    let mut s = app.0.lock().unwrap_or_else(|e| e.into_inner());
    match catch_unwind(AssertUnwindSafe(|| f(&mut s))) {
        Ok(Ok(body)) => Ok(Response::new(serde_json::to_vec(&body).unwrap())),
        Ok(Err(e)) => Err(fail(e)),
        Err(p) => {
            let text = p.downcast_ref::<String>().cloned().or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default();
            Err(fail(Error::Unexpected(text)))
        }
    }
}

/// One UI action (POST /api/<op> in the Python app). Returns the new state as JSON bytes.
#[tauri::command]
async fn api(app: AppHandle, op: String, args: Value) -> Result<Response, Value> {
    // file dialogs block: keep them off the window's thread
    run_blocking(app, move |s| s.handle(&op, &args)).await
}

/// A file dropped on the window: raw bytes, name in the X-File-Name header (URI-encoded).
#[tauri::command]
async fn upload(app: AppHandle, request: Request<'_>) -> Result<Response, Value> {
    let InvokeBody::Raw(data) = request.body() else {
        return Err(fail(Error::op("No file was dropped.")));
    };
    let data = data.clone();
    let name = request.headers().get("X-File-Name").and_then(|v| v.to_str().ok()).map(percent_decode).unwrap_or_else(|| "drop.dxf".into());
    run_blocking(app, move |s| s.upload(&name, &data)).await
}

async fn run_blocking<F>(app: AppHandle, f: F) -> Result<Response, Value>
where
    F: FnOnce(&mut Session) -> Result<Value, Error> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || with_session(&app.state::<App>(), f))
        .await
        .unwrap_or_else(|e| Err(fail(Error::Unexpected(e.to_string()))))
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![api, upload])
        .setup(|app| {
            let mut session = Session::new(Box::new(NativeDialogs { app: app.handle().clone() }));
            session.restore_autosave();
            app.manage(App(Mutex::new(session)));
            let mut w = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Stitchline")
                .inner_size(1480.0, 920.0)
                .min_inner_size(900.0, 600.0)
                .center()
                .initialization_script(FETCH_SHIM)
                // the UI handles dropped files itself (HTML drag and drop)
                .disable_drag_drop_handler()
                // keep WebView2 light on older computers
                .additional_browser_args(
                    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,Translate,msEdgeShopping,AutofillServerCommunication \
                     --disable-background-networking --disable-component-update --disable-sync --no-pings",
                );
            if std::env::var_os("STITCHLINE_HOME").is_some() {
                // tests: keep the window's own data (local storage, cache) with the rest of the test data
                w = w.data_directory(app_dir().join("webview"));
            }
            w.build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Stitchline");
}
