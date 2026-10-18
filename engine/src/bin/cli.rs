//! Test driver: runs a script of UI actions through the Rust session, exactly as the window would send them,
//! and prints every reply as JSON lines. tests/compare_with_python.py runs the same script through the Python app.
//!
//!     stitchline-cli script.json
//!
//! script.json: {"steps": [{"op": "open", "args": {...}, "answers": ["C:/path/for/dialogs", null]}, ...]}
//! "answers" are what the file dialogs return during that step (null = Cancel).
//! The op "__upload" opens {"name": ..., "file": path} the way a file dropped on the window is opened.
//! Set STITCHLINE_HOME for prefs/autosave and STITCHLINE_FIXED_TIME for the time stamp in SLW files.
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::Mutex;
use stitchline_engine::session::{Dialogs, FileTypes, Session};

struct Scripted {
    answers: Mutex<VecDeque<Option<String>>>,
}

impl Scripted {
    fn next(&self) -> Option<String> {
        self.answers.lock().unwrap().pop_front().flatten()
    }
}

struct Shared(std::sync::Arc<Scripted>);

impl Dialogs for Shared {
    fn ask_open(&self, _title: &str, _types: FileTypes, _initial_dir: &str) -> Option<String> {
        self.0.next()
    }
    fn ask_save(&self, _title: &str, _ext: &str, _types: FileTypes, _name: &str, _initial_dir: &str) -> Option<String> {
        self.0.next()
    }
}

fn main() {
    let path = std::env::args().nth(1).expect("usage: stitchline-cli script.json");
    let script: Value = serde_json::from_slice(&std::fs::read(&path).expect("read script")).expect("script is JSON");
    let dialogs = std::sync::Arc::new(Scripted { answers: Mutex::new(VecDeque::new()) });
    let mut s = Session::new(Box::new(Shared(dialogs.clone())));
    if script.get("restore_autosave").and_then(|v| v.as_bool()).unwrap_or(false) {
        s.restore_autosave();
    }
    for step in script["steps"].as_array().expect("steps") {
        {
            let mut q = dialogs.answers.lock().unwrap();
            q.clear();
            if let Some(a) = step.get("answers").and_then(|v| v.as_array()) {
                q.extend(a.iter().map(|v| v.as_str().map(String::from)));
            }
        }
        let op = step["op"].as_str().expect("op");
        let args = step.get("args").cloned().unwrap_or(json!({}));
        let res = if op == "__upload" {
            let data = std::fs::read(args["file"].as_str().unwrap()).expect("upload file");
            s.upload(args["name"].as_str().unwrap(), &data)
        } else {
            s.handle(op, &args)
        };
        let line = match res {
            Ok(body) => json!({"status": 200, "body": body}),
            Err(e) => json!({"status": e.status(), "body": {"error": e.text()}}),
        };
        println!("{}", serde_json::to_string(&line).unwrap());
    }
}
