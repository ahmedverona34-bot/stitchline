//! Session behaviour the window relies on: settings that would never finish stitching, drawings too large to
//! stitch, the autosave (what comes back at the next start, and how it is written) and redo after an insert.
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use stitchline_engine::session::{Dialogs, FileTypes, Session};

/// File dialogs that return the answers queued for them (None = Cancel).
#[derive(Clone, Default)]
struct Answers(Arc<Mutex<VecDeque<Option<String>>>>);

impl Answers {
    fn push(&self, p: &Path) {
        self.0.lock().unwrap().push_back(Some(p.to_string_lossy().into_owned()));
    }
}

impl Dialogs for Answers {
    fn ask_open(&self, _: &str, _: FileTypes, _: &str) -> Option<String> {
        self.0.lock().unwrap().pop_front().flatten()
    }
    fn ask_save(&self, _: &str, _: &str, _: FileTypes, _: &str, _: &str) -> Option<String> {
        self.0.lock().unwrap().pop_front().flatten()
    }
}

/// The project folder.
fn rebuild() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
}

/// An empty folder for one test's prefs, autosave and files.
fn home(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("stitchline-test-{}-{}", std::process::id(), name));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn session(dir: &Path) -> (Session, Answers) {
    let a = Answers::default();
    (Session::with_dir(Box::new(a.clone()), dir.to_path_buf()), a)
}

fn state(s: &mut Session) -> Value {
    s.handle("state", &json!({})).unwrap()
}

fn error(r: Result<Value, stitchline_engine::Error>) -> String {
    match r {
        Ok(_) => panic!("expected an error"),
        Err(e) => e.text(),
    }
}

/// Run f on another thread; fail instead of waiting for ever when it does not finish.
fn within<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    rx.recv_timeout(Duration::from_secs(60)).expect("did not finish (endless loop?)")
}

/// A 25 mm line on the first layer; returns (shape id, layer id).
fn add_line(s: &mut Session) -> (i64, String) {
    let st = s.handle("add_shape", &json!({"kind": "line", "x": 0, "y": 0, "size": 25})).unwrap();
    let id = st["new_id"].as_i64().unwrap();
    (id, s.job.shape(id).unwrap().layer.clone())
}

const TOO_MANY: &str = "This job would have more than 2,000,000 needle positions. Check the size of the drawing and the stitch settings.";
const TOO_LARGE: &str = "The drawing is too large: every point must be within 1,000,000 mm of the origin.";

// ------------------------------------------------------------------ settings that would never finish

#[test]
fn a_double_length_of_zero_or_less_is_refused() {
    let (mut s, _) = session(&home("double-refused"));
    let (_, lid) = add_line(&mut s);
    for bad in [json!(0), json!(-1.5), json!("0")] {
        let a = json!({"id": lid, "fields": {"settings": {"double_on": true, "double_odd": 1, "double_len": bad}}});
        let (msg, back) = within(move || (error(s.handle("update_layer", &a)), s));
        s = back;
        assert_eq!(msg, "Double length must be more than 0 mm.");
        // the refused change is undone as a whole
        assert_eq!(s.job.layer(&lid).unwrap().settings["double_on"], json!(false));
    }
    s.handle("update_layer", &json!({"id": lid, "fields": {"settings": {"double_on": true, "double_len": 0.5}}})).unwrap();
}

#[test]
fn a_job_that_already_has_a_double_length_of_zero_still_stitches() {
    // a job file or autosave written before the check: stitch with the normal length instead of hanging
    let (mut s, _) = session(&home("double-zero-job"));
    let (id, lid) = add_line(&mut s);
    let ls = &mut s.job.layer_mut(&lid).unwrap().settings;
    for (k, v) in [("double_on", json!(true)), ("double_odd", json!(1)), ("double_even", json!(1)), ("double_len", json!(0))] {
        ls.insert(k.into(), v);
    }
    s.touch();
    let st = within(move || state(&mut s));
    let p = st["stitched"][id.to_string()]["p"].as_array().unwrap();
    // 25 mm at 2.2 mm: about a dozen positions (two numbers each) and the back-tacks
    assert!(p.len() / 2 < 40, "{} positions", p.len() / 2);
}

// ------------------------------------------------------------------ drawings too large to stitch

#[test]
fn a_drawing_with_huge_numbers_is_refused_and_the_open_job_kept() {
    let dir = home("huge-open");
    let (mut s, _) = session(&dir);
    add_line(&mut s);
    // 400000000000 plotter units = 10,000 km
    let far = dir.join("far.plt");
    std::fs::write(&far, "IN;SP1;PU0,0;PD400000000000,0;PU;").unwrap();
    // within the limit, but three 1,950 m lines at 2.2 mm make about 2.6 million positions
    let long = dir.join("long.plt");
    std::fs::write(&long, "IN;SP1;PU-39000000,0;PD39000000,0,-39000000,1000,39000000,2000;PU;").unwrap();
    let (msgs, mut s) = within(move || {
        let a = error(s.handle("open", &json!({"path": far.to_string_lossy()})));
        let b = error(s.handle("open", &json!({"path": long.to_string_lossy()})));
        let c = error(s.upload("long.plt", &std::fs::read(&long).unwrap()));
        ((a, b, c), s)
    });
    assert_eq!(msgs, (TOO_LARGE.to_string(), TOO_MANY.to_string(), TOO_MANY.to_string()));
    let st = state(&mut s);
    assert_eq!(st["job"]["shapes"].as_array().unwrap().len(), 1);
}

#[test]
fn an_edit_that_makes_the_job_too_large_is_undone() {
    let dir = home("huge-edit");
    let (mut s, _) = session(&dir);
    let (id, lid) = add_line(&mut s);
    let before = s.job.shape(id).unwrap().pts.clone();
    let undo = s.job.undo_stack.len();
    let msg = error(s.handle("scale", &json!({"ids": [id], "sx": 1e7, "sy": 1})));
    assert_eq!(msg, TOO_LARGE);
    // a back-tack repeated a million million times
    let msg = error(s.handle("update_layer", &json!({"id": lid, "fields": {"settings": {"bt_start": 1, "bt_start_rep": 1e12}}})));
    assert_eq!(msg, TOO_MANY);
    assert_eq!(s.job.shape(id).unwrap().pts, before);
    assert_eq!(s.job.layer(&lid).unwrap().settings["bt_start_rep"], json!(1));
    assert_eq!(s.job.undo_stack.len(), undo);
    state(&mut s);
    // nor did the refused edits reach the autosave
    let saved: Value = serde_json::from_slice(&std::fs::read(dir.join("autosave.stitchline")).unwrap()).unwrap();
    let xs: Vec<f64> = saved["shapes"][0]["pts"].as_array().unwrap().iter().map(|p| p[0].as_f64().unwrap()).collect();
    assert_eq!(xs, [0.0, 25.0]);
}

#[test]
fn an_autosave_too_large_to_stitch_is_not_restored() {
    // it would stop Stitchline again at every start
    let dir = home("huge-autosave");
    let (mut s, _) = session(&dir);
    let (id, _) = add_line(&mut s);
    s.job.shape_mut(id).unwrap().pts = vec![(0.0, 0.0), (5e9, 0.0)];
    s.touch();
    let (mut s, _) = session(&dir);
    s.restore_autosave();
    let st = state(&mut s);
    assert!(st["job"]["shapes"].as_array().unwrap().is_empty());
}

// ------------------------------------------------------------------ the autosave

fn restored(dir: &Path) -> Value {
    let (mut s, _) = session(dir);
    s.restore_autosave();
    state(&mut s)
}

#[test]
fn the_autosave_follows_open_new_and_save() {
    let dir = home("autosave");
    let (demo, test) = (rebuild().join("tests/data/drawings/demo.plt"), rebuild().join("reference/test.dxf"));
    let (mut s, dlg) = session(&dir);
    s.handle("open", &json!({"path": demo.to_string_lossy()})).unwrap();
    s.handle("rename_job", &json!({"name": "Edited"})).unwrap();
    s.handle("open", &json!({"path": test.to_string_lossy()})).unwrap();
    // the last file opened comes back, not the job edited before it
    let st = restored(&dir);
    assert_eq!(st["job"]["name"], json!("test"));
    assert_eq!(st["file"]["dirty"], json!(true));

    let job = dir.join("saved.stitchline");
    dlg.push(&job);
    s.handle("save", &json!({})).unwrap();
    let st = restored(&dir);
    assert_eq!(st["file"]["path"], json!(job.to_string_lossy()));
    assert_eq!(st["file"]["dirty"], json!(false));

    s.handle("open", &json!({"path": job.to_string_lossy()})).unwrap();
    s.handle("new", &json!({})).unwrap();
    s.handle("open", &json!({"path": job.to_string_lossy()})).unwrap();
    let st = restored(&dir);
    assert_eq!(st["file"]["path"], json!(job.to_string_lossy()));
    assert_eq!(st["file"]["dirty"], json!(false));
    assert_eq!(st["job"]["shapes"].as_array().unwrap().len(), state(&mut s)["job"]["shapes"].as_array().unwrap().len());

    s.handle("new", &json!({})).unwrap();
    let st = restored(&dir);
    assert!(st["job"]["shapes"].as_array().unwrap().is_empty());
    assert_eq!(st["file"]["path"], Value::Null);
}

#[test]
fn an_autosave_without_dirty_is_of_unsaved_changes() {
    // autosaves written before "_dirty" was kept
    let dir = home("autosave-old");
    let (mut s, _) = session(&dir);
    add_line(&mut s);
    let p = dir.join("autosave.stitchline");
    let mut d: Value = serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
    d.as_object_mut().unwrap().remove("_dirty");
    std::fs::write(&p, serde_json::to_vec(&d).unwrap()).unwrap();
    assert_eq!(restored(&dir)["file"]["dirty"], json!(true));
}

#[test]
fn the_autosave_and_prefs_are_written_whole() {
    let dir = home("atomic");
    let (mut s, dlg) = session(&dir);
    let (id, _) = add_line(&mut s);
    dlg.push(&dir.join("job.stitchline"));
    s.handle("save", &json!({})).unwrap();
    s.handle("move", &json!({"ids": [id], "dx": 1, "dy": 0})).unwrap();
    let mut names: Vec<String> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    // no temporary files left behind
    assert_eq!(names, ["autosave.stitchline", "job.stitchline", "prefs.json"]);
    for n in ["autosave.stitchline", "prefs.json"] {
        serde_json::from_slice::<Value>(&std::fs::read(dir.join(n)).unwrap()).unwrap();
    }
    // a write replaces the file that is there
    let st = restored(&dir);
    assert_eq!(st["file"]["dirty"], json!(true));
    assert_eq!(st["job"]["shapes"][0]["pts"][0], json!([1.0, 0.0]));
}

// ------------------------------------------------------------------ insert, undo and redo

#[test]
fn insert_clears_redo() {
    let (mut s, dlg) = session(&home("insert-redo"));
    add_line(&mut s);
    add_line(&mut s);
    let st = s.handle("undo", &json!({})).unwrap();
    assert_eq!(st["can_redo"], json!(true));
    dlg.push(&rebuild().join("reference/test.dxf"));
    let st = s.handle("insert", &json!({})).unwrap();
    assert_eq!(st["can_redo"], json!(false));
    let n = st["job"]["shapes"].as_array().unwrap().len();
    // redo has nothing to bring back that would drop the inserted shapes
    let st = s.handle("redo", &json!({})).unwrap();
    assert_eq!(st["job"]["shapes"].as_array().unwrap().len(), n);
    assert_eq!(st["message"], Value::Null);
}

#[test]
fn a_failed_insert_leaves_undo_as_it_was() {
    let (mut s, dlg) = session(&home("insert-fail"));
    add_line(&mut s);
    let undo = s.job.undo_stack.len();
    dlg.push(&rebuild().join("tests/data/drawings/unsupported.edi"));
    assert!(s.handle("insert", &json!({})).is_err());
    assert_eq!(s.job.undo_stack.len(), undo);
}

// ------------------------------------------------------------------ the Home screen

#[test]
fn new_job_takes_a_name_and_a_table_size() {
    let (mut s, _) = session(&home("new-job-args"));
    add_line(&mut s);
    let st = s.handle("new", &json!({"name": "  Jacket back  ", "table_w": 1200, "table_h": 600.5})).unwrap();
    assert_eq!(st["file"]["name"], json!("Jacket back"));
    assert_eq!(st["file"]["dirty"], json!(false));
    assert_eq!(st["job"]["settings"]["table_w"], json!(1200.0));
    assert_eq!(st["job"]["settings"]["table_h"], json!(600.5));
    assert!(st["job"]["shapes"].as_array().unwrap().is_empty());
    // a blank name keeps "Untitled"; no size keeps the last one
    let st = s.handle("new", &json!({"name": " "})).unwrap();
    assert_eq!(st["file"]["name"], json!("Untitled"));
    assert_eq!(st["job"]["settings"]["table_w"], json!(1200.0));
    for bad in [json!(0), json!(-5), json!("x"), json!(1e9)] {
        assert!(s.handle("new", &json!({"table_w": bad})).is_err());
    }
}

#[test]
fn home_lists_the_recent_files_and_previews_them() {
    let dir = home("home-recent");
    let (mut s, _) = session(&dir);
    let dxf = rebuild().join("reference/parity/p1_lines_offset.dxf");
    let dxf = dxf.to_string_lossy().into_owned();
    s.handle("open", &json!({"path": dxf})).unwrap();
    let h = s.handle("home", &json!({})).unwrap();
    let r = &h["recent"][0];
    assert_eq!(r["path"], json!(dxf));
    assert_eq!(r["name"], json!("p1_lines_offset.dxf"));
    assert!(r["modified"].as_u64().unwrap() > 0 && r["size"].as_u64().unwrap() > 0);
    assert!(h["job"]["shapes"].as_u64().unwrap() > 0);

    // the preview reads the file without touching the open job
    let shapes = s.job.shapes.len();
    let p = s.handle("preview", &json!({"path": dxf})).unwrap();
    assert!(!p["paths"].as_array().unwrap().is_empty());
    assert_eq!(p["box"].as_array().unwrap().len(), 4);
    assert_eq!(s.job.shapes.len(), shapes);
    // a file that cannot be read has an empty preview, not an error
    let p = s.handle("preview", &json!({"path": dir.join("missing.dxf").to_string_lossy()})).unwrap();
    assert!(p["paths"].as_array().unwrap().is_empty() && p["box"].is_null());

    let h = s.handle("forget_recent", &json!({"path": dxf})).unwrap();
    assert!(h["recent"].as_array().unwrap().is_empty());
    assert!(state(&mut s)["recent"].as_array().unwrap().is_empty());
}

// ------------------------------------------------------------------ the layers list

#[test]
fn place_moves_shapes_to_a_layer_and_reorders_them_in_one_undo_step() {
    let (mut s, _) = session(&home("place"));
    let (a, l1) = add_line(&mut s);
    let (b, _) = add_line(&mut s);
    let (c, _) = add_line(&mut s);
    s.handle("add_layer", &json!({})).unwrap();
    let l2 = s.job.layers.last().unwrap().id.clone();
    assert_ne!(l2, l1);
    let st = s.handle("place", &json!({"ids": [c], "layer": l2, "order": [c, a, b]})).unwrap();
    assert_eq!(st["job"]["order"], json!([c, a, b]));
    assert_eq!(s.job.shape(c).unwrap().layer, l2);
    assert_eq!(s.job.shape(a).unwrap().layer, l1);
    // without a layer only the order changes
    s.handle("place", &json!({"ids": [a], "order": [a, c, b]})).unwrap();
    assert_eq!(s.job.shape(a).unwrap().layer, l1);
    let st = s.handle("undo", &json!({})).unwrap();
    assert_eq!(st["job"]["order"], json!([c, a, b]));
    let st = s.handle("undo", &json!({})).unwrap();
    assert_eq!(st["job"]["order"], json!([a, b, c]));
    assert_eq!(s.job.shape(c).unwrap().layer, l1);
}

#[test]
fn copying_a_sewing_layers_settings_leaves_laser_layers_alone_in_one_undo_step() {
    let (mut s, _) = session(&home("copy-settings"));
    let (_, sew) = add_line(&mut s);
    s.handle("add_layer", &json!({})).unwrap();
    let laser = s.job.layers.last().unwrap().id.clone();
    s.handle("add_layer", &json!({})).unwrap();
    let other = s.job.layers.last().unwrap().id.clone();
    // the window's "Laser cut" button, then a stitch length of its own on the sewing layer
    let off = json!({"convert": false, "bt_start": 0, "bt_end": 0, "cl_start": 0, "cl_end": 0, "end_repeat": 0});
    s.handle("update_layer", &json!({"id": laser, "fields": {"needle": 3, "settings": off}})).unwrap();
    s.handle("update_layer", &json!({"id": sew, "fields": {"settings": {"stitch_len": 4.5}}})).unwrap();
    let (laser_before, other_before) = (s.job.layer(&laser).unwrap().settings.clone(), s.job.layer(&other).unwrap().settings.clone());
    s.handle("copy_layer_settings", &json!({"id": sew})).unwrap();
    assert_eq!(s.job.layer(&laser).unwrap().settings, laser_before);
    assert_eq!(s.job.layer(&other).unwrap().settings, s.job.layer(&sew).unwrap().settings);
    s.handle("undo", &json!({})).unwrap();
    assert_eq!(s.job.layer(&other).unwrap().settings, other_before);
    assert_eq!(s.job.layer(&sew).unwrap().settings["stitch_len"], json!(4.5));
}
