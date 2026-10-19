//! The app session: the open job, undo/redo, preferences, autosave, and every UI action.
//! (port of stitchline.py: Session, state(), handle(), open/save/export/save_machine, upload)
use crate::error::{Error, Res};
use crate::model::{get_f, get_s, Job, Map, Snapshot};
use crate::platform;
use crate::stitches::{self, StitchMap, Stitched};
use crate::{exporters, importers, laserfix, machine, ops, program, py};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub const JOB_EXT: &str = ".stitchline";

pub type FileTypes = &'static [(&'static str, &'static str)];

pub const OPEN_TYPES: FileTypes = &[
    ("Drawings", "*.dxf *.ai *.plt *.hpgl *.prt *.dst *.dsb *.slw"),
    ("Stitchline jobs", "*.stitchline"),
    ("Machine files", "*.slw"),
    ("DXF", "*.dxf"),
    ("Illustrator", "*.ai"),
    ("HPGL plot", "*.plt *.hpgl *.prt"),
    ("Embroidery", "*.dst *.dsb"),
    ("All files", "*.*"),
];

pub const INSERT_TYPES: FileTypes = &[
    ("Drawings", "*.dxf *.ai *.plt *.hpgl *.prt *.dst *.dsb *.slw"),
    ("Machine files", "*.slw"),
    ("DXF", "*.dxf"),
    ("Illustrator", "*.ai"),
    ("HPGL plot", "*.plt *.hpgl *.prt"),
    ("Embroidery", "*.dst *.dsb"),
    ("All files", "*.*"),
];

/// Native file dialogs (the window provides them; tests script them).
pub trait Dialogs: Send + Sync {
    fn ask_open(&self, title: &str, types: FileTypes, initial_dir: &str) -> Option<String>;
    fn ask_save(&self, title: &str, ext: &str, types: FileTypes, name: &str, initial_dir: &str) -> Option<String>;
}

/// Where prefs.json and the autosave live: %STITCHLINE_HOME% (tests) or %APPDATA%\Stitchline.
pub fn app_dir() -> PathBuf {
    if let Some(h) = std::env::var_os("STITCHLINE_HOME").filter(|v| !v.is_empty()) {
        return PathBuf::from(h);
    }
    let base = std::env::var_os("APPDATA").filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or_else(home);
    base.join("Stitchline")
}

fn home() -> PathBuf {
    std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}

pub struct Session {
    pub prefs: Map,
    pub job: Job,
    pub path: Option<String>,
    pub dirty: bool,
    pub redo: Vec<Snapshot>,
    pub message: Option<String>,
    cache: Option<(StitchMap, Vec<Value>, Value)>,
    stitch_cache: HashMap<i64, (u64, Stitched)>,
    sent: HashMap<i64, u64>,
    dir: PathBuf,
    dialogs: Box<dyn Dialogs>,
}

/// Output of one action: the state for the window and the message to show.
pub struct Reply {
    pub body: Value,
}

fn arg<'a>(a: &'a Value, k: &str) -> Res<&'a Value> {
    a.get(k).ok_or(Error::Missing)
}

/// _f(a, k, d): float(a.get(k, d)) with 'Enter a number for k.' on failure
fn f(a: &Value, k: &str, d: f64) -> Res<f64> {
    match a.get(k) {
        None => Ok(d),
        Some(v) => py::to_float(v).ok_or_else(|| Error::Op(format!("Enter a number for {}.", k))),
    }
}

fn ids(a: &Value, k: &str) -> Res<Vec<i64>> {
    match arg(a, k)? {
        Value::Array(v) => Ok(v.iter().filter_map(id_of).collect()),
        Value::Null => Err(Error::Unexpected("'NoneType' object is not iterable".into())),
        _ => Err(Error::Unexpected("ids must be a list".into())),
    }
}

/// A shape id from the window (an int, or a float with no fraction)
fn id_of(v: &Value) -> Option<i64> {
    match v {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64)),
        _ => None,
    }
}

/// a['id'] as a shape id; a value that matches no shape gives 'That item no longer exists.'
fn sid(a: &Value, k: &str) -> Res<i64> {
    id_of(arg(a, k)?).ok_or(Error::Missing)
}

fn int_arg(a: &Value, k: &str) -> Res<i64> {
    let v = arg(a, k)?;
    py::to_int(v).ok_or_else(|| Error::Op(format!("invalid literal for int() with base 10: {}", py::py_repr(v))))
}

fn str_arg(a: &Value, k: &str) -> Res<String> {
    Ok(match arg(a, k)? {
        Value::String(s) => s.clone(),
        v => py::py_str(v),
    })
}

fn opt_str(a: &Value, k: &str) -> Option<String> {
    match a.get(k) {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(v) => Some(py::py_str(v)),
    }
}

fn truncate(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// str.isalnum() for the characters a job name can have (letters and digits of any script, not marks)
fn is_alnum(c: char) -> bool {
    if !c.is_alphanumeric() {
        return false;
    }
    let u = c as u32;
    // combining marks count as alphabetic in Rust but not for Python (Arabic harakat etc.)
    !matches!(u, 0x0300..=0x036F | 0x0483..=0x0489 | 0x0591..=0x05C7 | 0x0610..=0x061A | 0x064B..=0x065F | 0x0670
        | 0x06D6..=0x06DC | 0x06DF..=0x06E4 | 0x06E7..=0x06E8 | 0x06EA..=0x06ED | 0x08D3..=0x08FF | 0x0900..=0x0903
        | 0x093A..=0x094F | 0x1AB0..=0x1AFF | 0x1DC0..=0x1DFF | 0x20D0..=0x20FF | 0xFE20..=0xFE2F)
}

fn exists(p: &str) -> bool {
    Path::new(p).exists()
}

/// Write through a temporary file, so a crash while writing never leaves half a file.
fn write_atomic(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    std::fs::write(&tmp, data)?;
    std::fs::rename(&tmp, path)
}

/// Stitch a job that is not the session's yet: Err when it is too large; else the stitch cache for it.
fn stitch_check(job: &Job) -> Res<HashMap<i64, (u64, Stitched)>> {
    let mut cache = HashMap::new();
    stitches::stitch_job(job, Some(&mut cache))?;
    Ok(cache)
}

impl Session {
    pub fn new(dialogs: Box<dyn Dialogs>) -> Session {
        Session::with_dir(dialogs, app_dir())
    }

    /// A session that keeps prefs.json and the autosave in `dir`.
    pub fn with_dir(dialogs: Box<dyn Dialogs>, dir: PathBuf) -> Session {
        let mut s = Session {
            prefs: Map::new(),
            job: Job::new(),
            path: None,
            dirty: false,
            redo: vec![],
            message: None,
            cache: None,
            stitch_cache: HashMap::new(),
            sent: HashMap::new(),
            dir,
            dialogs,
        };
        s.prefs = s.load_prefs();
        s
    }

    fn prefs_path(&self) -> PathBuf {
        self.dir.join("prefs.json")
    }

    fn autosave_path(&self) -> PathBuf {
        self.dir.join("autosave.stitchline")
    }

    fn load_prefs(&self) -> Map {
        std::fs::read(self.prefs_path())
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .and_then(|v| match v {
                Value::Object(m) => Some(m),
                _ => None,
            })
            .unwrap_or_default()
    }

    fn save_prefs(&self) -> Res<()> {
        std::fs::create_dir_all(&self.dir).map_err(|e| Error::Unexpected(platform::os_error(&e, &self.dir)))?;
        // json.dump(prefs, f, indent=1) in a Python text file
        let mut buf = Vec::new();
        let mut ser = serde_json::Serializer::with_formatter(&mut buf, serde_json::ser::PrettyFormatter::with_indent(b" "));
        serde::Serialize::serialize(&Value::Object(self.prefs.clone()), &mut ser).unwrap();
        let text = String::from_utf8(buf).unwrap().replace('\n', "\r\n");
        write_atomic(&self.prefs_path(), text.as_bytes()).map_err(|e| Error::Unexpected(platform::os_error(&e, &self.prefs_path())))
    }

    fn last_dir(&self) -> String {
        match self.prefs.get("last_dir") {
            Some(Value::String(s)) if !s.is_empty() => s.clone(),
            _ => home().to_string_lossy().into_owned(),
        }
    }

    fn ask_open(&self, title: &str, types: FileTypes) -> Option<String> {
        self.dialogs.ask_open(title, types, &self.last_dir())
    }

    fn ask_save(&self, title: &str, ext: &str, types: FileTypes, name: &str) -> Option<String> {
        self.dialogs.ask_save(title, ext, types, name, &self.last_dir()).map(|p| {
            // like tkinter's defaultextension: add the extension when the name has none
            if platform::splitext(&p).1.is_empty() { format!("{}{}", p, ext) } else { p }
        })
    }

    pub fn reset(&mut self, job: Job, path: Option<String>) {
        self.job = job;
        self.path = path;
        self.dirty = false;
        self.redo.clear();
        self.cache = None;
    }

    /// The job changed: mark it unsaved and autosave it.
    pub fn touch(&mut self) {
        self.cache = None;
        self.changed();
    }

    /// touch() for a change already stitched by check(), so the stitches are not computed again.
    fn changed(&mut self) {
        self.dirty = true;
        self.autosave();
    }

    /// Keep the job, its file and whether it is saved, for the next start (restore_autosave).
    fn autosave(&self) {
        let mut d = self.job.to_dict();
        if let Value::Object(m) = &mut d {
            m.insert("_path".into(), json!(self.path));
            m.insert("_dirty".into(), json!(self.dirty));
        }
        if std::fs::create_dir_all(&self.dir).is_ok() {
            let _ = write_atomic(&self.autosave_path(), &serde_json::to_vec(&d).unwrap());
        }
    }

    /// (stitches, program steps, stats), recomputed after a change; only changed shapes are re-stitched.
    /// Err when the job is too large to stitch (the stitch cache is then left as it was).
    fn computed(&mut self) -> Res<&(StitchMap, Vec<Value>, Value)> {
        if self.cache.is_none() {
            let st = stitches::stitch_job(&self.job, Some(&mut self.stitch_cache))?;
            let (steps, stats) = program::build(&self.job, &st);
            self.cache = Some((st, steps, stats));
        }
        Ok(self.cache.as_ref().unwrap())
    }

    /// Stitch the changed job; Err when it is too large.
    fn check(&mut self) -> Res<()> {
        self.cache = None;
        self.computed().map(|_| ())
    }

    pub fn restore_autosave(&mut self) {
        let Ok(b) = std::fs::read(self.autosave_path()) else { return };
        let Ok(d) = serde_json::from_slice::<Value>(&b) else { return };
        let Ok(job) = Job::from_dict(&d) else { return };
        // a job too large to stitch would stop Stitchline again at every start
        let Ok(cache) = stitch_check(&job) else { return };
        let path = d.get("_path").and_then(|v| v.as_str()).map(String::from);
        self.reset(job, path);
        self.stitch_cache = cache;
        // autosaves written before "_dirty" was kept are of unsaved changes
        self.dirty = d.get("_dirty").and_then(|v| v.as_bool()).unwrap_or(true);
    }

    fn remember(&mut self, path: &str) -> Res<()> {
        self.prefs.insert("last_dir".into(), json!(platform::dirname(path)));
        let rec: Vec<Value> = match self.prefs.get("recent") {
            Some(Value::Array(a)) => a.iter().filter(|p| p.as_str() != Some(path)).cloned().collect(),
            _ => vec![],
        };
        let mut new = vec![json!(path)];
        new.extend(rec.into_iter().take(7));
        self.prefs.insert("recent".into(), Value::Array(new));
        self.save_prefs()
    }

    /// The whole state the window draws from.
    pub fn state(&mut self, full: bool) -> Res<Value> {
        self.computed()?;
        let job = &self.job;
        let (_, steps, stats) = self.cache.as_ref().unwrap();
        let mut out = match job.to_dict() {
            Value::Object(m) => m,
            _ => unreachable!(),
        };
        let shapes: Vec<Value> = job
            .shapes
            .iter()
            .map(|s| {
                let mut v = serde_json::to_value(s).unwrap();
                v["pts"] = Value::Array(s.pts.iter().map(|&(x, y)| json!([py::round_n(x, 4), py::round_n(y, 4)])).collect());
                v
            })
            .collect();
        out.insert("shapes".into(), Value::Array(shapes));
        // send stitches only for shapes whose stitches the window does not have yet
        let mut changed = Map::new();
        for s in &job.shapes {
            if let Some((key, (pts, fl))) = self.stitch_cache.get(&s.id) {
                if full || self.sent.get(&s.id) != Some(key) {
                    let p: Vec<Value> = pts.iter().flat_map(|&(x, y)| [py::num(py::round_n(x, 4)), py::num(py::round_n(y, 4))]).collect();
                    changed.insert(s.id.to_string(), json!({"p": p, "f": fl}));
                }
            }
        }
        self.sent = self.stitch_cache.iter().map(|(k, (key, _))| (*k, *key)).collect();
        let name = match &self.path {
            Some(p) => platform::basename(p),
            None => job.name.clone(),
        };
        let recent: Vec<Value> = match self.prefs.get("recent") {
            Some(Value::Array(a)) => a.iter().filter(|p| p.as_str().map(exists).unwrap_or(false)).cloned().collect(),
            _ => vec![],
        };
        let mut laser = Map::new();
        for l in &job.layers {
            if l.needle == 3 {
                laser.insert(l.id.clone(), laserfix::check(job, &l.id));
            }
        }
        let mut m = Map::new();
        m.insert("job".into(), Value::Object(out));
        m.insert("stitched".into(), Value::Object(changed));
        m.insert("stitched_full".into(), json!(full));
        m.insert("program".into(), Value::Array(steps.clone()));
        m.insert("stats".into(), stats.clone());
        m.insert("file".into(), json!({"path": self.path, "name": name, "dirty": self.dirty}));
        m.insert("can_undo".into(), json!(!job.undo_stack.is_empty()));
        m.insert("can_redo".into(), json!(!self.redo.is_empty()));
        m.insert("recent".into(), Value::Array(recent));
        m.insert("drives".into(), json!(platform::removable_drives()));
        m.insert("laser".into(), Value::Object(laser));
        m.insert("instructions".into(), json!(ops::INSTRUCTIONS));
        m.insert("events".into(), json!(program::EVENTS));
        m.insert("defaults".into(), Value::Object(program::job_defaults(job)));
        m.insert("message".into(), json!(self.message));
        Ok(Value::Object(m))
    }

    // ------------------------------------------------------------------ file actions

    pub fn open_path(&mut self, path: &str, keep_in_recent: bool) -> Res<String> {
        let ext = platform::splitext(path).1.to_lowercase();
        let base = platform::basename(path);
        if ext == JOB_EXT {
            let data = std::fs::read(path).map_err(|e| Error::Unexpected(platform::os_error(&e, Path::new(path))))?;
            let d: Value = serde_json::from_slice(&data).map_err(|e| Error::Op(e.to_string()))?;
            let job = Job::from_dict(&d).map_err(Error::Op)?;
            let cache = stitch_check(&job)?;
            self.reset(job, Some(path.to_string()));
            self.stitch_cache = cache;
            if keep_in_recent {
                self.remember(path)?;
            }
            return Ok(format!("Opened {}", base));
        }
        let paths = importers::read_any(path, get_f(&self.job.settings, "dpi", 1016.0))?;
        if paths.is_empty() {
            return Err(Error::op("This file has no drawing in it."));
        }
        let mut job = Job::new();
        job.settings = self.job.settings.clone(); // keep the opening options the user set
        job.name = platform::splitext(&base).0;
        job.source = Some(path.to_string());
        let settings = job.settings.clone();
        let (_, removed, joined) = ops::load_paths(&mut job, paths, &settings, "");
        let cache = stitch_check(&job)?;
        self.reset(job, None);
        self.stitch_cache = cache;
        self.dirty = true;
        if keep_in_recent {
            self.remember(path)?;
        }
        let mut msg = format!("Opened {} · {} shapes", base, self.job.shapes.len());
        if removed > 0 {
            msg += &format!(" · {} overlaps removed", removed);
        }
        if joined > 0 {
            msg += &format!(" · {} lines joined", joined);
        }
        Ok(msg)
    }

    fn save_job(&mut self, as_new: bool) -> Res<Option<String>> {
        let mut path = self.path.clone();
        if as_new || path.is_none() {
            let name = format!("{}{}", if self.job.name.is_empty() { "job" } else { &self.job.name }, JOB_EXT);
            path = self.ask_save("Save job", JOB_EXT, &[("Stitchline job", "*.stitchline")], &name);
            if path.is_none() {
                return Ok(None);
            }
        }
        let path = path.unwrap();
        let data = serde_json::to_vec(&self.job.to_dict()).unwrap();
        std::fs::write(&path, data).map_err(|e| Error::Unexpected(platform::os_error(&e, Path::new(&path))))?;
        self.path = Some(path.clone());
        self.dirty = false;
        self.job.name = platform::splitext(&platform::basename(&path)).0;
        self.autosave();
        self.remember(&path)?;
        Ok(Some(format!("Saved {}", platform::basename(&path))))
    }

    fn export(&mut self, kind: &str, args: &Value) -> Res<Option<String>> {
        let st = self.computed()?.0.clone();
        let base = if self.job.name.is_empty() { "job".to_string() } else { self.job.name.clone() };
        let mode = match args.get("mode") {
            Some(Value::String(s)) => s.clone(),
            Some(v) => py::py_str(v),
            None => get_s(&self.job.settings, "dxf_mode", "geometry").to_string(),
        };
        let err = |e: String| Error::Unexpected(e);
        match kind {
            "dxf" => {
                let Some(p) = self.ask_save("Export DXF for the machine program", ".dxf", &[("DXF drawing", "*.dxf")], &format!("{}.dxf", base)) else {
                    return Ok(None);
                };
                let n = exporters::write_dxf(&self.job, Path::new(&p), Some(&st), &mode).map_err(err)?;
                Ok(Some(format!("Exported {} shapes to {}", n, platform::basename(&p))))
            }
            "plt" => {
                let Some(p) = self.ask_save("Export PLT (HPGL plot)", ".plt", &[("PLT plot file", "*.plt")], &format!("{}.plt", base)) else {
                    return Ok(None);
                };
                let dpi = get_f(&self.job.settings, "dpi", 1016.0);
                let n = exporters::write_plt(&self.job, Path::new(&p), Some(&st), &mode, dpi).map_err(err)?;
                Ok(Some(format!("Exported {} shapes to {}", n, platform::basename(&p))))
            }
            "svg" => {
                let Some(p) = self.ask_save("Export picture", ".svg", &[("SVG picture", "*.svg")], &format!("{}.svg", base)) else {
                    return Ok(None);
                };
                exporters::write_svg(&self.job, Path::new(&p), &st).map_err(err)?;
                Ok(Some(format!("Exported {}", platform::basename(&p))))
            }
            "csv" => {
                let Some(p) = self.ask_save("Export stitch list", ".csv", &[("CSV table", "*.csv")], &format!("{}_stitches.csv", base)) else {
                    return Ok(None);
                };
                exporters::write_csv(&self.job, Path::new(&p), &st).map_err(err)?;
                Ok(Some(format!("Exported {}", platform::basename(&p))))
            }
            _ => Err(Error::op("Unknown export.")),
        }
    }

    /// Write the machine file (.slw): straight onto a USB drive, or through a Save dialog.
    fn save_machine(&mut self, args: &Value) -> Res<Option<String>> {
        if self.job.sewn_shapes().is_empty() {
            return Err(Error::op("Nothing to sew: turn on at least one layer."));
        }
        let st = self.computed()?.0.clone();
        let src = if self.job.name.is_empty() { "job" } else { self.job.name.as_str() };
        let name: String = truncate(&src.chars().filter(|&c| is_alnum(c) || c == '-' || c == '_').collect::<String>(), 12);
        let name = if name.is_empty() { "job".to_string() } else { name };
        let drive = args.get("drive").filter(|v| py::truthy(Some(v)));
        let path = if let Some(d) = drive {
            let d = d.as_str().unwrap_or("").to_string();
            if !platform::removable_drives().contains(&d) {
                return Err(Error::op("That USB drive is no longer connected."));
            }
            platform::join(&d, &format!("{}.slw", name))
        } else {
            match self.ask_save("Save machine file", ".slw", &[("SLW machine file", "*.slw")], &format!("{}.slw", name)) {
                Some(p) => p,
                None => return Ok(None),
            }
        };
        let n = machine::write_slw(&self.job, &st, Path::new(&path)).map_err(Error::Unexpected)?;
        self.prefs.insert("last_machine_file".into(), json!(path));
        self.save_prefs()?;
        let shown = if drive.is_some() { path.clone() } else { platform::basename(&path) };
        Ok(Some(format!("Saved machine file {} ({} records)", shown, n)))
    }

    // ------------------------------------------------------------------ edits

    /// One edit; returns the message (Some for edits that report one) and, for add_shape / duplicate, new ids.
    fn edit(&mut self, op: &str, a: &Value) -> Res<Option<EditOut>> {
        let j = &mut self.job;
        let msg = |s: String| Ok(Some(EditOut::Msg(s)));
        match op {
            "move" => ops::move_(j, &ids(a, "ids")?, f(a, "dx", 0.0)?, f(a, "dy", 0.0)?)?,
            "rotate" => ops::rotate(j, &ids(a, "ids")?, f(a, "angle", 0.0)?)?,
            "mirror" => {
                let axis = str_arg(a, "axis")?;
                ops::mirror(j, &ids(a, "ids")?, &axis)?
            }
            "scale" => ops::scale(j, &ids(a, "ids")?, f(a, "sx", 1.0)?, f(a, "sy", 1.0)?)?,
            "scale_all" => ops::scale_all(j, f(a, "sx", 1.0)?, f(a, "sy", 1.0)?),
            "reverse" => ops::reverse(j, &ids(a, "ids")?)?,
            "set_start" => ops::set_start(j, sid(a, "id")?, f(a, "x", 0.0)?, f(a, "y", 0.0)?)?,
            "start_at" => {
                let side = str_arg(a, "side")?;
                ops::start_at(j, &ids(a, "ids")?, &side)?
            }
            "extend" => ops::extend_ends(j, &ids(a, "ids")?, f(a, "start", 0.0)?, f(a, "end", 0.0)?)?,
            "set_points" => {
                let pts = arg(a, "pts")?.clone();
                ops::set_points(j, sid(a, "id")?, &pts, a.get("closed").unwrap_or(&Value::Null))?
            }
            "split" => {
                let id = sid(a, "id")?;
                ops::split_at(j, id, int_arg(a, "index")?)?;
            }
            "merge_points" => return msg(format!("{} points merged", ops::merge_points(j, &ids(a, "ids")?, f(a, "tol", 0.3)?)?)),
            "delete_short" => return msg(format!("{} short lines deleted", ops::delete_short(j, &ids(a, "ids")?, f(a, "min", 3.5)?)?)),
            "join" => return msg(format!("{} lines joined", ops::join_lines(j, &ids(a, "ids")?, f(a, "tol", 2.0)?, false)?)),
            "remove_overlaps" => return msg(format!("{} overlapping shapes removed", ops::remove_overlaps(j, &ids(a, "ids")?))),
            "delete" => ops::delete(j, &ids(a, "ids")?)?,
            "duplicate" => {
                let (i, dx, dy) = (ids(a, "ids")?, f(a, "dx", 0.0)?, f(a, "dy", 0.0)?);
                let new = ops::duplicate(j, &i, dx, dy, py::truthy(a.get("mh")), py::truthy(a.get("mv")))?;
                return Ok(Some(EditOut::Duplicated(new)));
            }
            "add_shape" => {
                let kind = str_arg(a, "kind")?;
                let (x, y, size) = (f(a, "x", 0.0)?, f(a, "y", 0.0)?, f(a, "size", 10.0)?);
                let wh = |k: &str| a.get(k).filter(|v| py::truthy(Some(v))).and_then(py::to_float);
                let id = ops::add_shape(j, &kind, x, y, size, opt_str(a, "layer"), wh("w"), wh("h"))?;
                return Ok(Some(EditOut::NewId(id)));
            }
            "set_layer" => {
                let l = str_arg(a, "layer")?;
                ops::set_layer(j, &ids(a, "ids")?, &l)?
            }
            "add_layer" => return msg(ops::add_layer(j, &opt_str(a, "name").unwrap_or_default())),
            "update_layer" => {
                let id = str_arg(a, "id")?;
                let fields = match arg(a, "fields")? {
                    Value::Object(m) => m.clone(),
                    _ => return Err(Error::Unexpected("fields must be a dict".into())),
                };
                ops::update_layer(j, &id, &fields)?
            }
            "copy_layer_settings" => ops::copy_layer_settings(j, &str_arg(a, "id")?)?,
            "delete_layer" => ops::delete_layer(j, &str_arg(a, "id")?)?,
            "group" => {
                let i = ids(a, "ids")?;
                let name = opt_str(a, "name").unwrap_or_default();
                let needle = a.get("needle").cloned().unwrap_or(json!(1));
                let color = a.get("color").cloned().unwrap_or(Value::Null);
                return msg(ops::make_group(j, &i, &name, &needle, &color)?);
            }
            "ungroup" => return msg(ops::ungroup(j, &str_arg(a, "id")?)?),
            "remove_empty_groups" => ops::remove_empty_groups(j),
            "move_group" => {
                let id = str_arg(a, "id")?;
                ops::move_group(j, &id, int_arg(a, "delta")?)?
            }
            "rename_shape" => {
                let id = sid(a, "id")?;
                let name = truncate(&str_arg(a, "name")?, 80);
                j.shape_mut(id).ok_or(Error::Missing)?.name = name;
            }
            "add_mark" => {
                let id = sid(a, "id")?;
                let kind = arg(a, "kind")?.clone();
                let (ma, mb) = (f(a, "a", 0.0)?, f(a, "b", 0.0)?);
                ops::add_mark(j, id, &kind, ma, mb, a.get("params").unwrap_or(&Value::Null))?
            }
            "clear_marks" => ops::clear_marks(j, &ids(a, "ids")?)?,
            "set_ref" => {
                let which = str_arg(a, "which")?;
                let id = match a.get("id") {
                    None | Some(Value::Null) => None,
                    Some(v) => Some(id_of(v).ok_or(Error::Missing)?),
                };
                ops::set_ref(j, &which, id)?
            }
            "reorder" => ops::reorder(j, &ids(a, "ids")?),
            "sort" => {
                let dir = str_arg(a, "dir")?;
                ops::sort_order(j, &dir, f(a, "spacing", 10.0)?, py::truthy(a.get("by_end")))?
            }
            "nearest" => ops::nearest_order(j)?,
            "laser_fix" => {
                let id = str_arg(a, "id")?;
                let tol = match a.get("tol") {
                    None => 0.05,
                    Some(v) => py::to_float(v).ok_or_else(|| Error::Op(format!("could not convert string to float: {}", py::py_repr(v))))?,
                };
                let (b, af) = laserfix::fix(j, &id, tol)?;
                return msg(format!(
                    "Laser paths sped up: {} → {} separate cuts, {} → {} points, {} → {} tiny segments",
                    b["shapes"], af["shapes"], b["points"], af["points"], b["tiny"], af["tiny"]
                ));
            }
            "order_by_group" => ops::order_by_group(j)?,
            "insert_instruction" => {
                let before = a.get("before").cloned().unwrap_or(json!("end"));
                let name = str_arg(a, "name")?;
                let value = a.get("value").cloned().unwrap_or(json!(""));
                ops::insert_instruction(j, before, &name, &value)?;
            }
            "move_instruction" => {
                let iid = arg(a, "iid")?.clone();
                ops::move_instruction(j, &iid, int_arg(a, "delta")?)?
            }
            "delete_instruction" => ops::delete_instruction(j, arg(a, "iid")?),
            "set_job" => {
                let values = match arg(a, "values")? {
                    Value::Object(m) => m.clone(),
                    _ => return Err(Error::Unexpected("values must be a dict".into())),
                };
                for (k, v) in values {
                    if j.settings.contains_key(&k) {
                        j.settings.insert(k, v);
                    }
                }
            }
            "rename_job" => {
                let n = truncate(&str_arg(a, "name")?, 80);
                j.name = if n.is_empty() { "Untitled".into() } else { n };
            }
            _ => return Err(Error::op(format!("Unknown action: {}", op))),
        }
        Ok(None)
    }

    /// Run one API action. Returns the body to send (state with 'message', or {'ok': true} for ping).
    pub fn handle(&mut self, op: &str, a: &Value) -> Res<Value> {
        let mut msg: Option<String> = None;
        match op {
            "state" => {
                let st = self.state(true)?;
                return Ok(self.with_message(st, None));
            }
            "ping" => return Ok(json!({"ok": true})),
            "new" => {
                let mut nj = Job::new();
                nj.settings = self.job.settings.clone();
                self.reset(nj, None);
                self.autosave();
                msg = Some("New job".into());
            }
            "open" => {
                let p = match a.get("path").filter(|v| py::truthy(Some(v))) {
                    Some(v) => Some(v.as_str().map(String::from).unwrap_or_else(|| py::py_str(v))),
                    None => self.ask_open("Open a drawing or job", OPEN_TYPES),
                };
                if let Some(p) = p {
                    msg = Some(self.open_path(&p, true)?);
                    self.autosave();
                }
            }
            "insert" => {
                if let Some(p) = self.ask_open("Insert a drawing into this job", INSERT_TYPES) {
                    self.job.snapshot();
                    let settings = self.job.settings.clone();
                    let r = ops::insert_file(&mut self.job, &p, &settings).and_then(|r| self.check().map(|_| r));
                    let (n, rem, jn) = match r {
                        Ok(r) => r,
                        Err(e) => {
                            self.job.undo();
                            self.cache = None;
                            return Err(e);
                        }
                    };
                    self.redo.clear();
                    self.changed();
                    msg = Some(format!("Inserted {} shapes from {}", n as i64 - jn as i64 - rem as i64, platform::basename(&p)));
                }
            }
            "save" => msg = self.save_job(py::truthy(a.get("as_new")))?,
            "export" => {
                let kind = str_arg(a, "kind")?;
                msg = self.export(&kind, a)?;
            }
            "save_machine" => msg = self.save_machine(a)?,
            "undo" => {
                let snap = self.job.current();
                if self.job.undo() {
                    self.redo.push(snap);
                    self.touch();
                    msg = Some("Undone".into());
                }
            }
            "redo" => {
                if let Some(s) = self.redo.pop() {
                    self.job.snapshot();
                    self.job.restore(s);
                    self.touch();
                    msg = Some("Redone".into());
                }
            }
            _ => {
                self.job.snapshot();
                // an edit that leaves the job too large to stitch is undone like one that fails
                let r = match self.edit(op, a).and_then(|r| self.check().map(|_| r)) {
                    Ok(r) => r,
                    Err(e) => {
                        self.job.undo();
                        self.cache = None;
                        return Err(e);
                    }
                };
                self.redo.clear();
                self.changed();
                match r {
                    Some(EditOut::Msg(m)) => msg = Some(m),
                    Some(EditOut::NewId(id)) => {
                        self.message = None;
                        let mut st = self.state(false)?;
                        st["new_id"] = json!(id);
                        return Ok(self.with_message(st, None));
                    }
                    Some(EditOut::Duplicated(new)) => {
                        if !new.is_empty() {
                            let mut st = self.state(false)?;
                            st["new_ids"] = json!(new);
                            return Ok(self.with_message(st, Some("Shape duplicated".into())));
                        }
                    }
                    None => {}
                }
            }
        }
        let st = self.state(false)?;
        Ok(self.with_message(st, msg))
    }

    fn with_message(&self, mut st: Value, msg: Option<String>) -> Value {
        if st.get("job").is_some() {
            st["message"] = json!(msg);
        }
        st
    }

    /// A file dropped on the window: open it from its bytes (a dropped file has no lasting path).
    pub fn upload(&mut self, name: &str, data: &[u8]) -> Res<Value> {
        let name = platform::basename(name);
        let name = if name.is_empty() { "drop.dxf".to_string() } else { name };
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let folder = std::env::temp_dir().join(format!("stitchline_{}_{}", std::process::id(), stamp));
        std::fs::create_dir_all(&folder).map_err(|e| Error::Unexpected(platform::os_error(&e, &folder)))?;
        let tmp = folder.join(&name);
        let res = std::fs::write(&tmp, data)
            .map_err(|e| Error::Unexpected(platform::os_error(&e, &tmp)))
            .and_then(|_| self.open_path(&tmp.to_string_lossy(), false));
        let _ = std::fs::remove_dir_all(&folder);
        let msg = res?;
        if self.path.as_deref().map(|p| Path::new(p).starts_with(&folder)).unwrap_or(false) {
            self.path = None; // a dropped job file: Save asks where to keep it
        }
        self.job.source = Some(name);
        self.autosave();
        let st = self.state(false)?;
        Ok(self.with_message(st, Some(msg)))
    }
}

enum EditOut {
    Msg(String),
    NewId(i64),
    Duplicated(Vec<i64>),
}
