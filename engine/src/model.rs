//! Job model: layers, shapes, sewing order and settings. (port of engine/model.py)
use crate::geom::{self, P};
use crate::py;
use serde::de::Deserializer;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;

pub type Map = serde_json::Map<String, Value>;

// the first layer of a drawing is white (it reads well on the dark canvas; the light one draws it in ink)
pub const PALETTE: [&str; 8] = ["#ffffff", "#7a5cff", "#13a3a3", "#f08c00", "#2f9e44", "#1c7ed6", "#c2255c", "#5f3dc4"];

pub fn default_layer_settings() -> Map {
    let v = json!({
        "convert": true,
        "stitch_len": 2.2,
        "sewing_mode": true,
        "travel_mode": "off",
        "bt_start": 1, "bt_end": 1, "bt_start_rep": 1, "bt_end_rep": 1,
        "cl_start": 0, "cl_start_rep": 1, "cl_end": 0, "cl_end_rep": 1,
        "end_repeat": 0,
        "corner_slow": true, "corner_angle": 45.0, "corner_slow_n": 5,
        "corner_dense": false, "corner_dense_n": 5, "corner_dense_f": 2.0,
        "se_dense": false, "se_dense_n": 0, "se_dense_f": 2.0,
        "special_len": 0.0, "special_needle": false, "special_speed": 1800,
        "double_on": false, "double_len": 2.5, "double_odd": 0, "double_even": 0
    });
    match v {
        Value::Object(m) => m,
        _ => unreachable!(),
    }
}

pub fn default_job_settings() -> Map {
    let v = json!({
        "remove_overlap": true, "no_join": false, "no_reference": false,
        "dpi": 1016.0, "scale_x": 1.0, "scale_y": 1.0, "scale_on_open": false,
        "table_w": 1000.0, "table_h": 800.0, "origin": "bl",
        "points_range": 50.0,
        "comp": {"x-": 0.0, "x+": 0.0, "y-": 0.0, "y+": 0.0, "on": false},
        "travel_corners": false, "travel_corner_angle": 25.0,
        "row_spacing": 10.0, "sort_by_end": false,
        "out_scale_on": false, "out_scale_x": 100.0, "out_scale_y": 100.0,
        "points_on": false,
        "speed": 1800, "speed_ramp_on": false, "speed_ramp_from": 600,
        "io_positions": [], "io_on_reverse": false, "io_reverse_port": 1,
        "defaults": null, "rotation_ratio": 1.0,
        "out_format": "slw", "dxf_mode": "geometry"
    });
    match v {
        Value::Object(m) => m,
        _ => unreachable!(),
    }
}

// ------------------------------------------------------------------ settings access with Python semantics

/// float(m.get(k, d))
pub fn get_f(m: &Map, k: &str, d: f64) -> f64 {
    match m.get(k) {
        None => d,
        Some(v) => py::to_float(v).unwrap_or(d),
    }
}

/// int(m.get(k, d))
pub fn get_i(m: &Map, k: &str, d: i64) -> i64 {
    match m.get(k) {
        None => d,
        Some(v) => py::to_int(v).unwrap_or(d),
    }
}

/// bool(m.get(k))
pub fn get_b(m: &Map, k: &str) -> bool {
    py::truthy(m.get(k))
}

/// bool(m.get(k, d))
pub fn get_bd(m: &Map, k: &str, d: bool) -> bool {
    match m.get(k) {
        None => d,
        v => py::truthy(v),
    }
}

pub fn get_s<'a>(m: &'a Map, k: &str, d: &'a str) -> &'a str {
    m.get(k).and_then(|v| v.as_str()).unwrap_or(d)
}

// ------------------------------------------------------------------ lenient field decoding (files written by any version)

fn de_int<'de, D: Deserializer<'de>>(d: D) -> Result<i64, D::Error> {
    let v = Value::deserialize(d)?;
    Ok(py::to_int(&v).unwrap_or(1))
}

fn de_bool<'de, D: Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    let v = Value::deserialize(d)?;
    Ok(py::truthy(Some(&v)))
}

fn de_string<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let v = Value::deserialize(d)?;
    Ok(match v {
        Value::String(s) => s,
        Value::Null => String::new(),
        other => py::py_str(&other),
    })
}

fn de_pts<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<P>, D::Error> {
    let v: Vec<Vec<Value>> = Vec::deserialize(d)?;
    Ok(v.iter()
        .map(|p| (p.first().and_then(py::to_float).unwrap_or(0.0), p.get(1).and_then(py::to_float).unwrap_or(0.0)))
        .collect())
}

fn ser_pts<S: serde::Serializer>(pts: &[P], s: S) -> Result<S::Ok, S::Error> {
    use serde::ser::SerializeSeq;
    let mut seq = s.serialize_seq(Some(pts.len()))?;
    for p in pts {
        seq.serialize_element(&[p.0, p.1])?;
    }
    seq.end()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Layer {
    #[serde(deserialize_with = "de_string")]
    pub id: String,
    #[serde(deserialize_with = "de_string", default)]
    pub name: String,
    #[serde(deserialize_with = "de_string", default)]
    pub color: String,
    #[serde(deserialize_with = "de_int", default = "one")]
    pub needle: i64,
    #[serde(deserialize_with = "de_bool", default = "yes")]
    pub output: bool,
    #[serde(default)]
    pub settings: Map,
    #[serde(flatten)]
    pub extra: Map,
}

fn one() -> i64 {
    1
}
fn yes() -> bool {
    true
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Shape {
    #[serde(deserialize_with = "de_int")]
    pub id: i64,
    #[serde(deserialize_with = "de_string")]
    pub layer: String,
    #[serde(deserialize_with = "de_pts", serialize_with = "ser_pts")]
    pub pts: Vec<P>,
    #[serde(deserialize_with = "de_bool", default)]
    pub closed: bool,
    #[serde(default)]
    pub marks: Vec<Map>,
    #[serde(deserialize_with = "de_string", default)]
    pub name: String,
    #[serde(flatten)]
    pub extra: Map,
}

/// An instruction the user added to the program (before a shape id or 'end').
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Instr {
    #[serde(deserialize_with = "de_int")]
    pub id: i64,
    pub before: Value,
    #[serde(deserialize_with = "de_string")]
    pub name: String,
    #[serde(deserialize_with = "de_string", default)]
    pub value: String,
    #[serde(flatten)]
    pub extra: Map,
}

#[derive(Clone, Debug)]
pub struct Snapshot {
    pub layers: Vec<Layer>,
    pub shapes: Vec<Shape>,
    pub order: Vec<i64>,
    pub settings: Map,
    pub refs: Map,
    pub program_extra: Vec<Instr>,
}

#[derive(Clone, Debug)]
pub struct Job {
    pub name: String,
    pub source: Option<String>,
    pub layers: Vec<Layer>,
    pub shapes: Vec<Shape>,
    pub order: Vec<i64>,
    pub settings: Map,
    pub refs: Map,
    pub program_extra: Vec<Instr>,
    next: i64,
    pub undo_stack: Vec<Snapshot>,
}

impl Default for Job {
    fn default() -> Self {
        Job::new()
    }
}

impl Job {
    pub fn new() -> Job {
        Job {
            name: "Untitled".into(),
            source: None,
            layers: vec![],
            shapes: vec![],
            order: vec![],
            settings: default_job_settings(),
            refs: Map::new(),
            program_extra: vec![],
            next: 1,
            undo_stack: vec![],
        }
    }

    pub fn next_id(&mut self) -> i64 {
        let i = self.next;
        self.next += 1;
        i
    }

    pub fn layer(&self, lid: &str) -> Option<&Layer> {
        self.layers.iter().find(|l| l.id == lid)
    }

    pub fn layer_mut(&mut self, lid: &str) -> Option<&mut Layer> {
        self.layers.iter_mut().find(|l| l.id == lid)
    }

    pub fn shape(&self, sid: i64) -> Option<&Shape> {
        self.shapes.iter().find(|s| s.id == sid)
    }

    pub fn shape_mut(&mut self, sid: i64) -> Option<&mut Shape> {
        self.shapes.iter_mut().find(|s| s.id == sid)
    }

    pub fn shape_index(&self) -> HashMap<i64, usize> {
        let mut m = HashMap::with_capacity(self.shapes.len());
        for (i, s) in self.shapes.iter().enumerate() {
            m.entry(s.id).or_insert(i);
        }
        m
    }

    pub fn ensure_layer(&mut self, name: &str) -> String {
        if let Some(l) = self.layers.iter().find(|l| l.name == name) {
            return l.id.clone();
        }
        let used: std::collections::HashSet<&str> = self.layers.iter().map(|l| l.id.as_str()).collect();
        let mut n = self.layers.len() + 1;
        while used.contains(format!("L{}", n).as_str()) {
            n += 1;
        }
        let lid = format!("L{}", n);
        let color = PALETTE[self.layers.len() % PALETTE.len()].to_string();
        self.layers.push(Layer {
            id: lid.clone(),
            name: name.to_string(),
            color,
            needle: 1,
            output: true,
            settings: default_layer_settings(),
            extra: Map::new(),
        });
        lid
    }

    pub fn add_shape(&mut self, layer_id: &str, pts: Vec<P>, closed: bool, index: Option<usize>) -> i64 {
        let id = self.next_id();
        self.shapes.push(Shape { id, layer: layer_id.to_string(), pts, closed, marks: vec![], name: String::new(), extra: Map::new() });
        match index {
            None => self.order.push(id),
            Some(i) => self.order.insert(i.min(self.order.len()), id),
        }
        id
    }

    pub fn remove_shape(&mut self, sid: i64) {
        self.shapes.retain(|s| s.id != sid);
        self.order.retain(|&i| i != sid);
    }

    fn snap(&self) -> Snapshot {
        Snapshot {
            layers: self.layers.clone(),
            shapes: self.shapes.clone(),
            order: self.order.clone(),
            settings: self.settings.clone(),
            refs: self.refs.clone(),
            program_extra: self.program_extra.clone(),
        }
    }

    pub fn current(&self) -> Snapshot {
        self.snap()
    }

    pub fn restore(&mut self, s: Snapshot) {
        self.layers = s.layers;
        self.shapes = s.shapes;
        self.order = s.order;
        self.settings = s.settings;
        self.refs = s.refs;
        self.program_extra = s.program_extra;
    }

    pub fn snapshot(&mut self) {
        let s = self.snap();
        self.undo_stack.push(s);
        if self.undo_stack.len() > 50 {
            let cut = self.undo_stack.len() - 50;
            self.undo_stack.drain(..cut);
        }
    }

    pub fn undo(&mut self) -> bool {
        match self.undo_stack.pop() {
            None => false,
            Some(s) => {
                self.restore(s);
                true
            }
        }
    }

    /// Shapes that go to the machine, in sewing order (layers turned on, not the alignment layer).
    pub fn sewn_shapes(&self) -> Vec<&Shape> {
        let idx = self.shape_index();
        let align = self.refs.get("align");
        let mut out = vec![];
        for sid in &self.order {
            let Some(&i) = idx.get(sid) else { continue };
            let s = &self.shapes[i];
            let Some(l) = self.layer(&s.layer) else { continue };
            let is_align = matches!(align, Some(Value::String(a)) if *a == l.id);
            if l.output && !is_align {
                out.push(s);
            }
        }
        out
    }

    pub fn bounds(&self) -> (f64, f64, f64, f64) {
        geom::bbox(self.shapes.iter().map(|s| s.pts.as_slice()))
    }

    pub fn ref_shape(&self, key: &str) -> Option<i64> {
        self.refs.get(key).and_then(|v| if v.is_null() { None } else { py::to_int(v) })
    }

    // ------------------------------------------------------------------ serialisation
    pub fn to_dict(&self) -> Value {
        let mut m = Map::new();
        m.insert("format".into(), json!("stitchline-job"));
        m.insert("version".into(), json!(1));
        m.insert("name".into(), json!(self.name));
        m.insert("source".into(), json!(self.source));
        m.insert("layers".into(), serde_json::to_value(&self.layers).unwrap());
        m.insert("shapes".into(), serde_json::to_value(&self.shapes).unwrap());
        m.insert("order".into(), json!(self.order));
        m.insert("settings".into(), Value::Object(self.settings.clone()));
        m.insert("refs".into(), Value::Object(self.refs.clone()));
        m.insert("program_extra".into(), serde_json::to_value(&self.program_extra).unwrap());
        Value::Object(m)
    }

    pub fn from_dict(d: &Value) -> Result<Job, String> {
        let bad = || "This is not a Stitchline job file.".to_string();
        if d.get("format").and_then(|v| v.as_str()) != Some("stitchline-job") {
            return Err(bad());
        }
        let mut j = Job::new();
        j.name = match d.get("name") {
            None => "Untitled".into(),
            Some(Value::String(s)) => s.clone(),
            Some(v) => py::py_str(v),
        };
        j.source = d.get("source").and_then(|v| v.as_str()).map(String::from);
        let layers = d.get("layers").ok_or_else(bad)?;
        j.layers = serde_json::from_value(layers.clone()).map_err(|e| e.to_string())?;
        for l in j.layers.iter_mut() {
            let mut s = default_layer_settings();
            for (k, v) in std::mem::take(&mut l.settings) {
                s.insert(k, v);
            }
            l.settings = s;
        }
        let shapes = d.get("shapes").ok_or_else(bad)?;
        j.shapes = serde_json::from_value(shapes.clone()).map_err(|e| e.to_string())?;
        let order = d.get("order").ok_or_else(bad)?;
        j.order = order.as_array().map(|a| a.iter().filter_map(py::to_int).collect()).unwrap_or_default();
        let mut s = default_job_settings();
        if let Some(Value::Object(m)) = d.get("settings") {
            for (k, v) in m {
                s.insert(k.clone(), v.clone());
            }
        }
        j.settings = s;
        if let Some(Value::Object(m)) = d.get("refs") {
            j.refs = m.clone();
        }
        if let Some(pe) = d.get("program_extra") {
            j.program_extra = serde_json::from_value(pe.clone()).map_err(|e| e.to_string())?;
        }
        let top = j.shapes.iter().map(|s| s.id).max().unwrap_or(0).max(0);
        j.next = top + 1;
        Ok(j)
    }
}
