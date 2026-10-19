//! The engine side of the canvas selection tools. Both arrows end a drag with one engine edit:
//!   black arrow (V): 'move' {ids, dx, dy}, or 'scale' {ids, sx, sy, ox, oy} for a bounding-box handle
//!                    (ox, oy = the fixed corner or edge, or the centre with Alt);
//!   white arrow (A): 'move' only.
//! These tests check that the edits keep each shape's geometry, make one undo step, survive save and reopen,
//! and give the same machine output.
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use stitchline_engine::geom::P;
use stitchline_engine::machine::{self, Record};
use stitchline_engine::model::Shape;
use stitchline_engine::session::FileTypes;
use stitchline_engine::{stitches, Dialogs, Session};

fn rebuild() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn tmp() -> PathBuf {
    let d = std::env::temp_dir().join(format!("stitchline_selection_tools_{}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// File dialogs that answer with fixed paths.
struct Scripted {
    save: Option<String>,
}
impl Dialogs for Scripted {
    fn ask_open(&self, _: &str, _: FileTypes, _: &str) -> Option<String> {
        None
    }
    fn ask_save(&self, _: &str, _: &str, _: FileTypes, _: &str, _: &str) -> Option<String> {
        self.save.clone()
    }
}

/// A session with its own prefs folder (tests run in parallel and sessions write prefs.json).
fn session(save: Option<String>) -> Session {
    static LOCK: Mutex<usize> = Mutex::new(0);
    let mut n = LOCK.lock().unwrap();
    *n += 1;
    std::env::set_var("STITCHLINE_HOME", tmp().join(format!("home{}", *n)));
    Session::new(Box::new(Scripted { save }))
}

/// A session with a drawing that has open polylines, closed shapes, circles and arcs (curves come in as points).
fn with_drawing(file: &str) -> Session {
    let mut s = session(None);
    let p = rebuild().join("reference").join("parity").join(file);
    s.handle("open", &json!({ "path": p.to_string_lossy() })).unwrap();
    assert!(!s.job.shapes.is_empty(), "{} has shapes", file);
    s
}

fn shape(s: &Session, id: i64) -> Shape {
    s.job.shape(id).unwrap().clone()
}

fn bbox(pts: &[P]) -> (f64, f64, f64, f64) {
    pts.iter().fold((f64::MAX, f64::MAX, f64::MIN, f64::MIN), |b, p| (b.0.min(p.0), b.1.min(p.1), b.2.max(p.0), b.3.max(p.1)))
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-9
}

/// Everything about a shape except its points is the same, and it has as many points.
fn same_except_points(a: &Shape, b: &Shape) {
    assert_eq!(a.id, b.id);
    assert_eq!(a.layer, b.layer, "stays on its layer");
    assert_eq!(a.closed, b.closed, "closed flag");
    assert_eq!(a.name, b.name);
    assert_eq!(a.marks, b.marks, "sections");
    assert_eq!(a.extra, b.extra);
    assert_eq!(a.pts.len(), b.pts.len(), "no points added or removed");
}

#[test]
fn move_translates_every_point_by_the_same_amount() {
    let mut s = with_drawing("p3_circles_arcs.dxf");
    let before = s.job.shapes.clone();
    let order = s.job.order.clone();
    let id = before.iter().max_by_key(|sh| sh.pts.len()).unwrap().id; // a circle or arc: many points
    let (dx, dy) = (12.345, -6.789);
    let undo_n = s.job.undo_stack.len();
    s.handle("move", &json!({ "ids": [id], "dx": dx, "dy": dy })).unwrap();
    assert_eq!(s.job.undo_stack.len(), undo_n + 1, "one drag is one undo step");
    for (a, b) in before.iter().zip(&s.job.shapes) {
        same_except_points(a, b);
        if a.id != id {
            assert_eq!(a.pts, b.pts, "other shapes do not move");
            continue;
        }
        for (p, q) in a.pts.iter().zip(&b.pts) {
            assert!(close(q.0 - p.0, dx) && close(q.1 - p.1, dy), "{:?} -> {:?}", p, q);
        }
        // relative geometry: every segment keeps its vector (so its length and angle)
        for i in 1..a.pts.len() {
            let va = (a.pts[i].0 - a.pts[i - 1].0, a.pts[i].1 - a.pts[i - 1].1);
            let vb = (b.pts[i].0 - b.pts[i - 1].0, b.pts[i].1 - b.pts[i - 1].1);
            assert!((va.0 - vb.0).abs() < 1e-9 && (va.1 - vb.1).abs() < 1e-9);
        }
    }
    assert_eq!(s.job.order, order, "sewing order unchanged");
    assert_eq!(s.job.shapes.len(), before.len());
}

#[test]
fn undo_and_redo_of_a_move_and_a_resize() {
    let mut s = with_drawing("p2_polylines.dxf");
    let ids: Vec<i64> = s.job.shapes.iter().map(|sh| sh.id).collect();
    let original = s.job.shapes.clone();
    s.handle("move", &json!({ "ids": ids, "dx": 3.5, "dy": 4.25 })).unwrap();
    let moved = s.job.shapes.clone();
    s.handle("scale", &json!({ "ids": [ids[0]], "sx": 1.5, "sy": 0.5, "ox": 0.0, "oy": 0.0 })).unwrap();
    let resized = s.job.shapes.clone();
    s.handle("undo", &json!({})).unwrap();
    assert_eq!(pts_of(&s.job.shapes), pts_of(&moved), "undo restores the size");
    s.handle("undo", &json!({})).unwrap();
    assert_eq!(pts_of(&s.job.shapes), pts_of(&original), "undo restores the position");
    s.handle("redo", &json!({})).unwrap();
    assert_eq!(pts_of(&s.job.shapes), pts_of(&moved));
    s.handle("redo", &json!({})).unwrap();
    assert_eq!(pts_of(&s.job.shapes), pts_of(&resized));
}

fn pts_of(shapes: &[Shape]) -> Vec<Vec<P>> {
    shapes.iter().map(|s| s.pts.clone()).collect()
}

/// A rectangle 40 x 20 mm with its lower left corner at (10, 5).
fn rect(s: &mut Session) -> i64 {
    let st = s.handle("add_shape", &json!({ "kind": "rect", "x": 10.0, "y": 5.0, "size": 40.0, "w": 40.0, "h": 20.0 })).unwrap();
    let id = st["new_id"].as_i64().unwrap();
    let (x0, y0, x1, y1) = bbox(&shape(s, id).pts);
    assert!(close(x1 - x0, 40.0) && close(y1 - y0, 20.0), "rect {:?}", (x0, y0, x1, y1));
    id
}

#[test]
fn corner_handle_resizes_about_the_opposite_corner() {
    let mut s = session(None);
    let id = rect(&mut s);
    let a = shape(&s, id);
    let (x0, y0, x1, y1) = bbox(&a.pts);
    // dragging the top right corner: the bottom left corner stays where it is
    s.handle("scale", &json!({ "ids": [id], "sx": 1.5, "sy": 2.0, "ox": x0, "oy": y0 })).unwrap();
    let b = shape(&s, id);
    same_except_points(&a, &b);
    let (u0, v0, u1, v1) = bbox(&b.pts);
    assert!(close(u0, x0) && close(v0, y0), "anchor corner fixed");
    assert!(close(u1 - u0, (x1 - x0) * 1.5) && close(v1 - v0, (y1 - y0) * 2.0));
    for (p, q) in a.pts.iter().zip(&b.pts) {
        assert!(close(q.0, x0 + (p.0 - x0) * 1.5) && close(q.1, y0 + (p.1 - y0) * 2.0), "every point mapped alike");
    }
}

#[test]
fn edge_handle_resizes_one_axis_only() {
    let mut s = session(None);
    let id = rect(&mut s);
    let a = shape(&s, id);
    let (_, y0, x1, y1) = bbox(&a.pts);
    // dragging the left edge: the right edge is the anchor, y is untouched
    s.handle("scale", &json!({ "ids": [id], "sx": 0.25, "sy": 1.0, "ox": x1, "oy": (y0 + y1) / 2.0 })).unwrap();
    let b = shape(&s, id);
    let (u0, v0, u1, v1) = bbox(&b.pts);
    assert!(close(u1, x1) && close(u1 - u0, 10.0));
    assert!(close(v0, y0) && close(v1, y1));
    for (p, q) in a.pts.iter().zip(&b.pts) {
        assert!(close(p.1, q.1), "y unchanged");
    }
}

#[test]
fn multi_selection_resizes_as_one_box() {
    let mut s = with_drawing("p4_layers.dxf");
    let ids: Vec<i64> = s.job.shapes.iter().map(|sh| sh.id).collect();
    let all: Vec<P> = s.job.shapes.iter().flat_map(|sh| sh.pts.clone()).collect();
    let (x0, y0, x1, y1) = bbox(&all);
    let layers: Vec<String> = s.job.shapes.iter().map(|sh| sh.layer.clone()).collect();
    s.handle("scale", &json!({ "ids": ids, "sx": 2.0, "sy": 2.0, "ox": x0, "oy": y1 })).unwrap();
    let after: Vec<P> = s.job.shapes.iter().flat_map(|sh| sh.pts.clone()).collect();
    let (u0, v0, u1, v1) = bbox(&after);
    assert!((u0 - x0).abs() < 1e-9 && (v1 - y1).abs() < 1e-9, "top left corner fixed");
    assert!(((u1 - u0) - 2.0 * (x1 - x0)).abs() < 1e-9 && ((v1 - v0) - 2.0 * (y1 - y0)).abs() < 1e-9);
    assert_eq!(layers, s.job.shapes.iter().map(|sh| sh.layer.clone()).collect::<Vec<_>>(), "layers kept");
}

#[test]
fn inspector_resize_still_uses_the_centre() {
    let mut s = session(None);
    let id = rect(&mut s);
    let (x0, y0, x1, y1) = bbox(&shape(&s, id).pts);
    s.handle("scale", &json!({ "ids": [id], "sx": 0.5, "sy": 0.5 })).unwrap();
    let (u0, v0, u1, v1) = bbox(&shape(&s, id).pts);
    assert!(close((u0 + u1) / 2.0, (x0 + x1) / 2.0) && close((v0 + v1) / 2.0, (y0 + y1) / 2.0));
    assert!(close(u1 - u0, 20.0) && close(v1 - v0, 10.0));
}

#[test]
fn a_size_of_zero_is_refused_and_changes_nothing() {
    let mut s = session(None);
    let id = rect(&mut s);
    let before = shape(&s, id).pts;
    let undo_n = s.job.undo_stack.len();
    for (sx, sy) in [(0.0, 1.0), (1.0, 0.0), (f64::NAN, 1.0)] {
        let a = if sx.is_nan() { json!({ "ids": [id], "sx": "nan", "sy": sy, "ox": 0, "oy": 0 }) } else { json!({ "ids": [id], "sx": sx, "sy": sy, "ox": 0, "oy": 0 }) };
        assert!(s.handle("scale", &a).is_err(), "scale {:?} refused", (sx, sy));
        assert_eq!(shape(&s, id).pts, before);
        assert_eq!(s.job.undo_stack.len(), undo_n, "no undo step for a refused edit");
    }
}

#[test]
fn save_and_reopen_keeps_moved_and_resized_shapes() {
    let out = tmp().join("moved.stitchline");
    let mut s = session(Some(out.to_string_lossy().into_owned()));
    let p = rebuild().join("reference").join("parity").join("p3_circles_arcs.dxf");
    s.handle("open", &json!({ "path": p.to_string_lossy() })).unwrap();
    let ids: Vec<i64> = s.job.shapes.iter().map(|sh| sh.id).collect();
    s.handle("move", &json!({ "ids": [ids[0]], "dx": 7.125, "dy": -2.5 })).unwrap();
    s.handle("scale", &json!({ "ids": [ids[1]], "sx": 1.25, "sy": 0.8, "ox": 1.0, "oy": 2.0 })).unwrap();
    let want = s.job.shapes.clone();
    s.handle("save", &json!({ "as_new": true })).unwrap();
    let mut r = session(None);
    r.handle("open", &json!({ "path": out.to_string_lossy() })).unwrap();
    assert_eq!(r.job.shapes.len(), want.len());
    for (a, b) in want.iter().zip(&r.job.shapes) {
        same_except_points(a, b);
        assert_eq!(a.pts, b.pts, "points of shape {} after reopening", a.id);
    }
}

#[test]
fn moving_a_shape_moves_its_stitches_without_changing_them() {
    let mut s = with_drawing("s3_closed.dxf");
    let id = s.job.shapes[0].id;
    let before = stitches::stitch_job(&s.job, None);
    s.handle("move", &json!({ "ids": [id], "dx": 4.0, "dy": -8.0 })).unwrap();
    let after = stitches::stitch_job(&s.job, None);
    let (pa, fa) = &before[&id];
    let (pb, fb) = &after[&id];
    assert_eq!(fa, fb, "same stitch kinds (tack, corner, ...)");
    assert_eq!(pa.len(), pb.len(), "same number of needle positions");
    for (p, q) in pa.iter().zip(pb) {
        assert!((q.0 - p.0 - 4.0).abs() < 1e-6 && (q.1 - p.1 + 8.0).abs() < 1e-6);
    }
}

fn records(s: &Session) -> Vec<Record> {
    let st = stitches::stitch_job(&s.job, None);
    machine::build_records(&s.job, &st, "job.slw", Some(1_700_000_000)).unwrap()
}

#[test]
fn machine_file_is_the_same_when_the_whole_job_moves() {
    // SLW positions are measured from the machine origin (a corner of the drawing), so moving everything
    // together must not change a single needle position; moving one shape must change the file.
    for file in ["p2_polylines.dxf", "s2_corner.dxf", "p6_pens.plt"] {
        let mut s = with_drawing(file);
        let a = records(&s);
        let ids: Vec<i64> = s.job.shapes.iter().map(|sh| sh.id).collect();
        s.handle("move", &json!({ "ids": ids, "dx": 16.0, "dy": -8.0 })).unwrap();
        let b = records(&s);
        assert_eq!(a.len(), b.len(), "{}", file);
        for (x, y) in a.iter().zip(&b) {
            let near = |u: u32, v: u32| (u as i32 as i64 - v as i32 as i64).abs() <= 1; // 1 micrometre
            assert!(x.0 == y.0 && x.1 == y.1 && near(x.2, y.2) && near(x.3, y.3), "{}: {:?} vs {:?}", file, x, y);
        }
        if ids.len() > 1 {
            s.handle("move", &json!({ "ids": [ids[0]], "dx": 5.0, "dy": 0.0 })).unwrap();
            assert_ne!(records(&s), b, "{}: moving one shape changes the file", file);
        }
    }
}

#[test]
fn resized_job_writes_a_valid_machine_file_that_reads_back() {
    let mut s = with_drawing("p3_circles_arcs.dxf");
    let read_back = |s: &Session| {
        let st = stitches::stitch_job(&s.job, None);
        let (bytes, n) = machine::slw_bytes(&s.job, &st, "resized.slw", Some(1_700_000_000)).unwrap();
        assert!(n > 0);
        machine::read_slw(&bytes).unwrap()
    };
    let before = read_back(&s);
    let ids: Vec<i64> = s.job.shapes.iter().map(|sh| sh.id).collect();
    let (x0, y0, _, _) = s.job.bounds();
    s.handle("scale", &json!({ "ids": ids, "sx": 0.5, "sy": 1.75, "ox": x0, "oy": y0 })).unwrap();
    let after = read_back(&s);
    println!("sewn shapes {}, paths read back before {} after {}", s.job.sewn_shapes().len(), before.len(), after.len());
    assert_eq!(after.len(), before.len(), "the resized job sews the same paths");
    // the job also exports to the other formats
    for kind in ["dxf", "plt", "svg", "csv"] {
        let out = tmp().join(format!("resized.{}", kind));
        let mut e = session(Some(out.to_string_lossy().into_owned()));
        e.job = s.job.clone();
        e.handle("export", &json!({ "kind": kind, "mode": "geometry" })).unwrap();
        assert!(std::fs::metadata(&out).map(|m| m.len() > 0).unwrap_or(false), "{} written", kind);
    }
}

#[test]
fn legacy_machine_file_opens_and_moves() {
    // an SLW machine file opened as a drawing gives plain point paths; they move like any other shape
    let mut s = with_drawing("p6_pens.slw");
    let a = s.job.shapes.clone();
    let ids: Vec<i64> = a.iter().map(|sh| sh.id).collect();
    s.handle("move", &json!({ "ids": ids, "dx": -1.5, "dy": 2.5 })).unwrap();
    for (p, q) in a.iter().zip(&s.job.shapes) {
        same_except_points(p, q);
        assert!(p.pts.iter().zip(&q.pts).all(|(u, v)| close(v.0 - u.0, -1.5) && close(v.1 - u.1, 2.5)));
    }
    let v: Value = s.state(false);
    assert_eq!(v["can_undo"], json!(true));
}
