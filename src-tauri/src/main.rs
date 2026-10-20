//! Stitchline desktop app: the window (WebView2) shows ../ui; every UI action goes to the
//! Rust engine (stitchline-engine) through two commands. A small script injected before the page loads turns the
//! UI's fetch('/api/<action>') calls into those commands, so the UI works the same as with the Python server.
// a window app in every build, debug included: no console window opens with it (nothing is printed to one)
#![windows_subsystem = "windows"]

use serde_json::{json, Value};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, TryLockError};
use stitchline_engine::session::{app_dir, preview_file, Dialogs, FileTypes, Session};
use stitchline_engine::Error;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_updater::{Update, UpdaterExt};

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
  // never show WebView2's own right-click menu (Back, Refresh, Save as, Inspect...); the UI opens its own menus
  window.addEventListener('contextmenu', e => e.preventDefault());
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
    // a Home screen preview reads a whole drawing: do it without holding the session, so the window keeps answering
    if op == "preview" {
        let path = args.get("path").and_then(Value::as_str).unwrap_or_default().to_string();
        let dpi = app.state::<App>().0.lock().unwrap_or_else(|e| e.into_inner()).dpi();
        return tauri::async_runtime::spawn_blocking(move || {
            catch_unwind(|| preview_file(&path, dpi)).unwrap_or_else(|_| json!({"paths": [], "closed": [], "box": null}))
        })
        .await
        .map(|v| Response::new(serde_json::to_vec(&v).unwrap()))
        .map_err(|e| fail(Error::Unexpected(e.to_string())));
    }
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

/// Set once the user has answered the close question (or there was nothing to save): the next close goes through.
static QUITTING: AtomicBool = AtomicBool::new(false);

/// Close the window after the close question. `discard`: the user chose Don't save, so the next start does not
/// bring the unsaved job back from the autosave.
#[tauri::command]
fn quit(app: AppHandle, discard: bool) {
    if discard {
        app.state::<App>().0.lock().unwrap_or_else(|e| e.into_inner()).discard_autosave();
    }
    QUITTING.store(true, Ordering::SeqCst);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.close();
    }
}

/// Settings › Interface size: the WebView's page zoom (1.0 = 100%), so buttons, panels and text grow together.
#[tauri::command]
fn set_zoom(window: tauri::WebviewWindow, scale: f64) -> Result<(), String> {
    window.set_zoom(scale.clamp(0.5, 2.0)).map_err(|e| e.to_string())
}

/// The window buttons drawn by the UI (the window has no Windows title bar): "min", "max" (maximize / restore),
/// "close" (goes through the close question like Alt+F4), or "state". Returns whether the window is maximized.
#[tauri::command]
fn window_ctl(window: tauri::WebviewWindow, action: String) -> Result<bool, String> {
    let r = match action.as_str() {
        "min" => window.minimize(),
        "max" if window.is_maximized().unwrap_or(false) => window.unmaximize(),
        "max" => window.maximize(),
        "close" => window.close(),
        _ => Ok(()),
    };
    r.map_err(|e| e.to_string())?;
    window.is_maximized().map_err(|e| e.to_string())
}

/// Updates (Settings › Check for updates, the Update button): the signed installer of the latest GitHub release
/// (tauri.conf.json › plugins.updater). The update found by the last check, and how much of it is downloaded.
#[derive(Default)]
struct Updates {
    found: Mutex<Option<Update>>,
    got: AtomicU64,
    total: AtomicU64,
}

/// {current, version, notes}: `version` is null when this is the latest one. An error when the check fails (offline).
#[tauri::command]
async fn update_check(app: AppHandle) -> Result<Value, String> {
    let current = app.package_info().version.to_string();
    let found = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    let reply = json!({
        "current": current,
        "version": found.as_ref().map(|u| u.version.clone()),
        "notes": found.as_ref().and_then(|u| u.body.clone()),
    });
    *app.state::<Updates>().found.lock().unwrap_or_else(|e| e.into_inner()) = found;
    Ok(reply)
}

/// Download the update found by update_check and run its installer, which closes Stitchline and opens the new
/// version (an unsaved job comes back from the autosave). Returns only if it fails.
#[tauri::command]
async fn update_install(app: AppHandle) -> Result<(), String> {
    let update = app.state::<Updates>().found.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let update = update.ok_or("No update to install.")?;
    let st = app.state::<Updates>();
    st.got.store(0, Ordering::SeqCst);
    st.total.store(0, Ordering::SeqCst);
    let bytes = update
        .download(
            |n, total| {
                st.got.fetch_add(n as u64, Ordering::SeqCst);
                st.total.store(total.unwrap_or(0), Ordering::SeqCst);
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    // not in the middle of an engine call (an autosave being written)
    let session = app.state::<App>();
    let _session = session.0.lock().unwrap_or_else(|e| e.into_inner());
    QUITTING.store(true, Ordering::SeqCst);
    update.install(bytes).map_err(|e| {
        QUITTING.store(false, Ordering::SeqCst);
        e.to_string()
    })
}

/// [downloaded, total] bytes of the update being downloaded (total 0 while unknown).
#[tauri::command]
fn update_progress(app: AppHandle) -> [u64; 2] {
    let st = app.state::<Updates>();
    [st.got.load(Ordering::SeqCst), st.total.load(Ordering::SeqCst)]
}

/// The window's X (or Alt+F4) with unsaved changes: keep the window and let the UI ask Save / Don't save / Cancel.
fn on_close_requested(app: &AppHandle, api: &tauri::CloseRequestApi) {
    if QUITTING.load(Ordering::SeqCst) {
        return;
    }
    let dirty = match app.state::<App>().0.try_lock() {
        Ok(s) => s.dirty,
        Err(TryLockError::Poisoned(e)) => e.into_inner().dirty,
        Err(TryLockError::WouldBlock) => true, // the engine is busy: let the UI decide
    };
    if !dirty {
        return;
    }
    api.prevent_close();
    if let Some(w) = app.get_webview_window("main") {
        // a page that failed to load has no close question: close anyway rather than never
        let _ = w.eval("window.__stitchlineClose ? window.__stitchlineClose() : window.__TAURI_INTERNALS__.invoke('quit', { discard: false })");
    }
}

/// The file Stitchline was started with (a project double-clicked in Explorer, "Open with"): the first argument
/// that is a file, relative paths taken from `cwd`.
fn file_arg(args: &[String], cwd: &str) -> Option<String> {
    args.iter().skip(1).filter(|a| !a.starts_with('-')).map(|a| PathBuf::from(cwd).join(a)).find(|p| p.is_file()).map(|p| p.to_string_lossy().into_owned())
}

/// The start-up file, until the UI takes it (once: a language switch reloads the page and must not open it again).
struct Launch(Mutex<Option<String>>);

#[tauri::command]
fn launch_file(app: AppHandle) -> Option<String> {
    app.state::<Launch>().0.lock().unwrap_or_else(|e| e.into_inner()).take()
}

/// Another Stitchline was started while this one is open (a second file double-clicked): bring this window up
/// and open the file here, so two windows never share one autosave.
fn second_instance(app: &AppHandle, args: Vec<String>, cwd: String) {
    let Some(w) = app.get_webview_window("main") else { return };
    let _ = w.unminimize();
    let _ = w.set_focus();
    if let Some(p) = file_arg(&args, &cwd) {
        let _ = w.eval(format!("window.__stitchlineOpen && window.__stitchlineOpen({})", json!(p)));
    }
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
    let args: Vec<String> = std::env::args().collect();
    let cwd = std::env::current_dir().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
    let mut builder = tauri::Builder::default();
    // tests (STITCHLINE_HOME) run beside an installed Stitchline that may be open
    if std::env::var_os("STITCHLINE_HOME").is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(second_instance));
    }
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Updates::default())
        .manage(Launch(Mutex::new(file_arg(&args, &cwd))))
        .invoke_handler(tauri::generate_handler![api, upload, quit, set_zoom, window_ctl, update_check, update_install, update_progress, launch_file])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                on_close_requested(window.app_handle(), api);
            }
        })
        .setup(|app| {
            let mut session = Session::new(Box::new(NativeDialogs { app: app.handle().clone() }));
            session.restore_autosave();
            app.manage(App(Mutex::new(session)));
            let mut w = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Stitchline")
                .inner_size(1480.0, 920.0)
                .min_inner_size(900.0, 600.0)
                .center()
                // open full screen (the size above is what Restore goes back to)
                .maximized(true)
                // the UI draws its own title bar (top bar + window buttons), in the app's colours
                .decorations(false)
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
