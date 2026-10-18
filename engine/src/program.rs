//! Build the machine program (the instruction list shown in Output) and job statistics. (port of engine/program.py)
use crate::geom::{self, P};
use crate::model::{get_b, get_f, Job, Map};
use crate::py;
use crate::stitches::StitchMap;
use serde_json::{json, Value};

pub const EVENTS: [&str; 20] = [
    "Job start", "Job end", "Sewing start", "Sewing end", "Layer start", "Layer end", "Shape start", "Shape end",
    "At corners", "Before sewing end", "Head 2 start", "Head 2 end", "Head 3 start", "Head 3 end",
    "Head 2 shape start", "Head 2 shape end", "Head 3 shape start", "Head 3 shape end",
    "Stitch shape start", "Stitch shape end",
];

/// What the machine program adds for head 3 (the laser) and for "Line to point" shapes.
pub fn default_events() -> Map {
    let mut m = Map::new();
    for e in EVENTS {
        m.insert(e.into(), json!([]));
    }
    m.insert("Head 3 start".into(), json!([{"name": "Output IO", "value": "5 on"}, {"name": "Delay", "value": "200"}]));
    m.insert("Head 3 end".into(), json!([{"name": "Output IO", "value": "5 off"}]));
    m.insert(
        "Head 3 shape start".into(),
        json!([{"name": "Output IO", "value": "2 on"}, {"name": "Delay", "value": "100"}, {"name": "Z axis", "value": "100"}]),
    );
    m.insert(
        "Head 3 shape end".into(),
        json!([{"name": "Output IO", "value": "2 off"}, {"name": "Delay", "value": "50"}, {"name": "Z axis", "value": "0"}]),
    );
    m.insert(
        "Stitch shape start".into(),
        json!([{"name": "Output IO", "value": "4 on"}, {"name": "Delay", "value": "120"}, {"name": "Output IO", "value": "4 off"}]),
    );
    m.insert("Stitch shape end".into(), json!([{"name": "Delay", "value": "0.001"}]));
    m
}

/// instructions that are written into the machine file; the others are kept in the job only for now
pub const IN_MACHINE_FILE: [&str; 4] = ["Speed", "Output IO", "Delay", "Z axis"];

fn nums(value: &Value) -> Vec<f64> {
    let s = if py::truthy(Some(value)) { py::py_str(value) } else { String::new() };
    let s = s.replace(',', " ");
    py::split_ws(&s).into_iter().filter_map(py::parse_float).collect()
}

pub type Rec = [i64; 5];

/// Machine-file records for one program instruction (empty if it is kept in the job only).
pub fn instruction_records(name: &str, value: &Value) -> Vec<Rec> {
    let n = nums(value);
    if n.is_empty() {
        return vec![];
    }
    match name {
        "Speed" => vec![[0x31, 0, 0, 100.max(3500.min(n[0] as i64)), 0]],
        "Output IO" => {
            let v = py::py_str(value).to_lowercase();
            let on = if v.contains("off") { 0 } else if n.len() > 1 { n[1] as i64 } else { 1 };
            vec![[6, 0, n[0] as i64 + 1, if on != 0 { 1 } else { 0 }, 0]]
        }
        "Delay" => vec![[0x05, 0, 0.max(py::round_int(n[0] * 1000.0)), 0, 0]], // milliseconds, stored x 1000
        "Z axis" => vec![[0x24, 0, py::round_int(n[0] * 1000.0), 0, 0]],      // mm, stored in micrometres
        _ => vec![],
    }
}

/// The instruction lists added at each event (the job's own, or the defaults).
pub fn job_defaults(job: &Job) -> Map {
    let d = job.settings.get("defaults");
    let dm = match d {
        Some(Value::Object(m)) if !m.is_empty() => m,
        _ => return default_events(),
    };
    let defs = default_events();
    let mut out = Map::new();
    for e in EVENTS {
        let v = dm.get(e).or_else(|| defs.get(e)).cloned().unwrap_or(json!([]));
        out.insert(e.into(), v);
    }
    out
}

/// Each instruction of an event: (name, value)
pub fn event_items(defaults: &Map, name: &str) -> Vec<(String, Value)> {
    match defaults.get(name) {
        Some(Value::Array(a)) => a
            .iter()
            .map(|ins| {
                let nm = ins.get("name").map(|v| match v {
                    Value::String(s) => s.clone(),
                    o => py::py_str(o),
                });
                (nm.unwrap_or_default(), ins.get("value").cloned().unwrap_or(Value::Null))
            })
            .collect(),
        _ => vec![],
    }
}

/// Drawing mm -> machine mm, using the chosen machine origin, output scale and the job's bounding box.
pub fn machine_xy_b(j: &Map, bounds: (f64, f64, f64, f64), p: P) -> P {
    let (x0, y0, x1, y1) = bounds;
    let o = j.get("origin").and_then(|v| v.as_str()).unwrap_or("bl");
    let mut x = p.0 - if o == "tr" || o == "br" { x1 } else { x0 };
    let mut y = p.1 - if o == "tl" || o == "tr" { y1 } else { y0 };
    if get_b(j, "out_scale_on") {
        x *= get_f(j, "out_scale_x", 100.0) / 100.0;
        y *= get_f(j, "out_scale_y", 100.0) / 100.0;
    }
    (x, y)
}

pub fn machine_xy(job: &Job, p: P) -> P {
    machine_xy_b(&job.settings, job.bounds(), p)
}

fn text_of(name: &str, value: &Value) -> String {
    if py::truthy(Some(value)) {
        format!("{} {}", name, py::py_str(value))
    } else {
        name.to_string()
    }
}

/// Program steps (kind, text, tag, shape?, iid?) plus stats.
pub fn build(job: &Job, stitched: &StitchMap) -> (Vec<Value>, Value) {
    let defaults = job_defaults(job);
    let mut steps: Vec<Value> = vec![];
    let ev = |steps: &mut Vec<Value>, name: &str| {
        for (n, v) in event_items(&defaults, name) {
            let tag = if IN_MACHINE_FILE.contains(&n.as_str()) { name.to_lowercase() } else { "job only".into() };
            steps.push(json!({"kind": "sys", "text": text_of(&n, &v), "tag": tag}));
        }
    };
    let user = |steps: &mut Vec<Value>, anchor: &Value| {
        for it in &job.program_extra {
            if py::py_eq(&it.before, anchor) {
                let v = Value::String(it.value.clone());
                let tag = if IN_MACHINE_FILE.contains(&it.name.as_str()) { "added" } else { "job only" };
                steps.push(json!({"kind": "user", "text": text_of(&it.name, &v), "tag": tag, "iid": it.id}));
            }
        }
    };
    let seq = job.sewn_shapes();
    let bounds = job.bounds();
    let jset = &job.settings;
    ev(&mut steps, "Job start");
    if job.ref_shape("r1").is_some() {
        steps.push(json!({"kind": "sys", "text": "Reference point 1", "tag": "align"}));
    }
    if job.ref_shape("r2").is_some() {
        steps.push(json!({"kind": "sys", "text": "Reference point 2", "tag": "align"}));
    }
    let mut pos: P = (0.0, 0.0);
    let (mut stitches, mut travel, mut sew_len) = (0.0f64, 0.0f64, 0.0f64);
    let mut cur_layer: Option<String> = None;
    let mut cur_needle: Option<i64> = None;
    let empty: (Vec<P>, String) = (vec![], String::new());
    for s in &seq {
        let Some(l) = job.layer(&s.layer) else { continue };
        let (pts, flags) = stitched.get(&s.id).unwrap_or(&empty);
        if pts.is_empty() {
            continue;
        }
        user(&mut steps, &json!(s.id));
        if cur_layer.as_deref() != Some(l.id.as_str()) {
            if cur_layer.is_some() {
                ev(&mut steps, "Layer end");
                steps.push(json!({"kind": "sys", "text": format!("Layer change → {}", l.name), "tag": "layer"}));
            }
            ev(&mut steps, "Layer start");
            cur_layer = Some(l.id.clone());
        }
        if Some(l.needle) != cur_needle {
            if let Some(n @ (2 | 3)) = cur_needle {
                ev(&mut steps, &format!("Head {} end", n));
            }
            let text = format!("Needle {}{}", l.needle, if l.needle == 3 { " (laser)" } else { "" });
            steps.push(json!({"kind": "sys", "text": text, "tag": "head"}));
            if l.needle == 2 || l.needle == 3 {
                ev(&mut steps, &format!("Head {} start", l.needle));
            }
            cur_needle = Some(l.needle);
        }
        if get_b(&l.settings, "special_needle") && flags.contains('x') {
            let sp = l.settings.get("special_speed").cloned().unwrap_or(json!(1800));
            steps.push(json!({"kind": "sys", "text": format!("Special speed {}", py::py_str(&sp)), "tag": "job only"}));
        }
        let (mx, my) = machine_xy_b(jset, bounds, pts[0]);
        steps.push(json!({"kind": "travel", "text": format!("Move to {}, {}", py::fixed(mx, 2), py::fixed(my, 2)), "tag": "travel", "shape": s.id}));
        travel += geom::dist(pos, pts[0]);
        ev(&mut steps, "Shape start");
        if let Some(n @ (2 | 3)) = cur_needle {
            ev(&mut steps, &format!("Head {} shape start", n));
        }
        ev(&mut steps, "Sewing start");
        if get_b(jset, "speed_ramp_on") {
            let a = jset.get("speed_ramp_from").cloned().unwrap_or(json!(600));
            let b = jset.get("speed").cloned().unwrap_or(json!(1800));
            steps.push(json!({"kind": "sys", "text": format!("Speed ramp {} → {} rpm", py::py_str(&a), py::py_str(&b)), "tag": "job only"}));
        }
        let nm = if s.name.is_empty() { format!("Shape {}", s.id) } else { s.name.clone() };
        if flags.contains('w') {
            ev(&mut steps, "At corners");
        }
        steps.push(json!({"kind": "sew", "text": format!("Sew {}", nm), "tag": format!("{} st", pts.len()), "shape": s.id}));
        if let Some(Value::Array(ios)) = jset.get("io_positions") {
            for io in ios {
                if io.get("shape").map(|v| py::py_eq(v, &json!(s.id))).unwrap_or(false) {
                    let port = io.get("port").cloned().unwrap_or(json!(1));
                    let at = io.get("at").cloned().unwrap_or(json!(1));
                    steps.push(json!({"kind": "sys", "text": format!("Output IO {} at stitch {}", py::py_str(&port), py::py_str(&at)), "tag": "job only"}));
                }
            }
        }
        if get_b(jset, "io_on_reverse") && flags.contains('b') {
            let port = jset.get("io_reverse_port").cloned().unwrap_or(json!(1));
            steps.push(json!({"kind": "sys", "text": format!("Output IO {} on reverse stitching", py::py_str(&port)), "tag": "job only"}));
        }
        ev(&mut steps, "Before sewing end");
        if let Some(n @ (2 | 3)) = cur_needle {
            ev(&mut steps, &format!("Head {} shape end", n));
        }
        ev(&mut steps, "Sewing end");
        ev(&mut steps, "Shape end");
        stitches += pts.len() as f64;
        sew_len += geom::path_length(pts);
        pos = pts[pts.len() - 1];
    }
    if let Some(n @ (2 | 3)) = cur_needle {
        ev(&mut steps, &format!("Head {} end", n));
    }
    if cur_layer.is_some() {
        ev(&mut steps, "Layer end");
    }
    user(&mut steps, &json!("end"));
    ev(&mut steps, "Job end");
    let rpm = {
        let r = get_f(jset, "speed", 1800.0);
        if r != 0.0 { r } else { 1800.0 }
    };
    let mut waits = 0.0f64;
    for st in &steps {
        // Delay instructions in the program (milliseconds)
        let text = st["text"].as_str().unwrap_or("");
        if text.starts_with("Delay ") {
            if let Some(v) = py::split_ws(text).get(1).and_then(|t| py::parse_float(t)) {
                waits += v / 1000.0;
            }
        }
    }
    let secs = stitches / rpm * 60.0 + travel / 150.0 + seq.len() as f64 * 1.5 + waits;
    let stats = json!({
        "stitches": stitches as i64, "sew_len": sew_len, "travel": travel, "shapes": seq.len(),
        "total_shapes": job.shapes.len(), "seconds": secs, "waits": waits
    });
    (steps, stats)
}
