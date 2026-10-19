//! Parity of the Rust SLW writer, the same cases as the Python version's tests/parity.py and test_machine.py:
//!   1. against the reference files written by the original program (same rules as parity.py: the time-stamped
//!      key record is skipped, positions may differ by 10 micrometres where the original rounds differently), and
//!   2. against the Python writer, record for record and byte for byte, key record included
//!      (tests/data/parity_python.json from tests/dump_python_parity.py, same time stamp).
use serde_json::Value;
use std::path::{Path, PathBuf};
use stitchline_engine::machine::{self, s32, Record};
use stitchline_engine::model::Job;
use stitchline_engine::program::machine_xy;
use stitchline_engine::{importers, ops, slw_container, stitches};

/// The project folder (reference files of the original program are in reference/).
fn rebuild() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn read_ref(p: &Path) -> Vec<Record> {
    let data = std::fs::read(p).unwrap();
    machine::decode_records(&slw_container::decode(&data).unwrap())
}

/// A job with the original program's default settings (stitch_mode: "Line to point" on).
fn job_like_original(src: &Path, stitch_mode: bool) -> Job {
    let mut j = Job::new();
    j.settings.insert("points_on".into(), Value::Bool(true));
    let base = src.file_name().unwrap().to_string_lossy().to_string();
    j.name = stitchline_engine::platform::splitext(&base).0;
    let paths = importers::read_any(&src.to_string_lossy(), 1016.0).unwrap();
    let settings = j.settings.clone();
    ops::load_paths(&mut j, paths, &settings, "");
    for l in j.layers.iter_mut() {
        let s = &mut l.settings;
        let set = |s: &mut serde_json::Map<String, Value>, k: &str, v: Value| {
            s.insert(k.into(), v);
        };
        if stitch_mode {
            for (k, v) in [
                ("convert", Value::Bool(true)), ("stitch_len", 2.2.into()), ("bt_start", 1.into()), ("bt_end", 1.into()),
                ("bt_start_rep", 1.into()), ("bt_end_rep", 1.into()), ("cl_start", 0.into()), ("cl_end", 0.into()),
                ("end_repeat", 0.into()), ("corner_dense", Value::Bool(false)), ("se_dense", Value::Bool(false)),
            ] {
                set(s, k, v);
            }
        } else {
            for (k, v) in [("convert", Value::Bool(false)), ("bt_start", 0.into()), ("bt_end", 0.into()), ("cl_start", 0.into()), ("cl_end", 0.into()), ("end_repeat", 0.into())] {
                set(s, k, v);
            }
        }
    }
    if base.contains("needle3") {
        // this reference was saved with Layer1 on 3Needle
        j.layers[0].needle = 3;
    }
    j
}

/// Machine positions where each shape starts in a reference file (moves made while not sewing).
fn ref_starts(r: &[Record]) -> Vec<(i64, i64)> {
    let mut out = vec![];
    let mut sewing = false;
    for &(code, w1, d4, d8, _) in r {
        if code == 0x43 {
            sewing = w1 == 0;
        } else if code == 0x35 && !sewing {
            out.push((s32(d4), s32(d8)));
        }
    }
    out
}

/// Put the job in the reference file's sewing order (matching each shape by its start point).
fn align_order(j: &mut Job, st: &stitches::StitchMap, r: &[Record]) {
    let starts = ref_starts(r);
    let mut left: Vec<(i64, (i64, i64))> = vec![];
    for s in &j.shapes {
        if let Some((pts, _)) = st.get(&s.id) {
            if let Some(&p) = pts.first() {
                let (x, y) = machine_xy(j, p);
                left.push((s.id, ((x * 1000.0).round_ties_even() as i64, (y * 1000.0).round_ties_even() as i64)));
            }
        }
    }
    let mut order = vec![];
    for p in starts {
        let d = |q: (i64, i64)| (q.0 - p.0).abs() + (q.1 - p.1).abs();
        let mut best: Option<usize> = None;
        for (k, item) in left.iter().enumerate() {
            if best.map(|b| d(item.1) < d(left[b].1)).unwrap_or(true) {
                best = Some(k);
            }
        }
        if let Some(b) = best {
            if d(left[b].1) <= 40 {
                order.push(left.remove(b).0);
            }
        }
    }
    let rest: Vec<i64> = j.order.iter().copied().filter(|i| !order.contains(i)).collect();
    order.extend(rest);
    j.order = order;
}

fn name_bytes(r: &[Record]) -> (u16, Vec<u8>) {
    let n: Vec<&Record> = r.iter().filter(|x| x.0 == 0x36 || x.0 == 0x37).collect();
    let mut raw = vec![];
    for v in [n[0].2, n[0].3, n[0].4, n[1].2] {
        raw.extend(v.to_be_bytes());
    }
    let end = raw.iter().position(|&b| b == 0).unwrap_or(raw.len());
    (n[0].1, raw[..end].to_vec())
}

fn build(src: &Path, ref_path: &Path, save_name: &str, stamp: Option<i64>) -> (Job, Vec<Record>) {
    let r = read_ref(ref_path);
    let mut j = job_like_original(src, ref_path.to_string_lossy().ends_with(".stitch.slw"));
    let st = stitches::stitch_job(&j, None).unwrap();
    align_order(&mut j, &st, &r);
    let recs = machine::build_records(&j, &st, save_name, stamp).unwrap();
    (j, recs)
}

/// Differences against a reference file of the original program (parity.py's rules). Returns indexes that differ.
fn compare_with_reference(src: &Path, ref_path: &Path, save_name: &str) -> Vec<String> {
    let r = read_ref(ref_path);
    let (_, mine) = build(src, ref_path, save_name, None);
    let mut bad = vec![];
    if name_bytes(&r) != name_bytes(&mine) {
        bad.push(format!("name differs: {:?} vs {:?}", name_bytes(&r), name_bytes(&mine)));
        return bad;
    }
    if r.len() != mine.len() {
        bad.push(format!("record count: reference {}, rust {}", r.len(), mine.len()));
    }
    for i in 0..r.len().max(mine.len()) {
        let (Some(a), Some(b)) = (r.get(i), mine.get(i)) else { continue };
        if a.0 == 0x33 && b.0 == 0x33 {
            continue; // time-stamped key record differs by design
        }
        if a.0 == b.0 && (a.0 == 0x36 || a.0 == 0x37) {
            continue; // name compared above
        }
        if a == b {
            continue;
        }
        let tol = 10;
        let close = a.0 == b.0
            && a.1 == b.1
            && (s32(a.2) - s32(b.2)).abs() <= tol
            && (s32(a.3) - s32(b.3)).abs() <= tol
            && (a.4 == b.4 || ((a.4 & 0xFFFF) == 0xFFFF && (b.4 & 0xFFFF) == 0xFFFF && ((a.4 >> 16) as i64 - (b.4 >> 16) as i64).abs() <= 8));
        if !close {
            bad.push(format!("record {}: reference {:?}, rust {:?}", i, a, b));
        }
    }
    bad
}

fn cases() -> Vec<(PathBuf, PathBuf, String)> {
    let folder = rebuild().join("reference").join("parity");
    let mut names: Vec<String> = std::fs::read_dir(&folder).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
    names.sort();
    let mut out = vec![];
    for n in names {
        let low = n.to_lowercase();
        if !(low.ends_with(".dxf") || low.ends_with(".plt")) {
            continue;
        }
        let src = folder.join(&n);
        let stem = stitchline_engine::platform::splitext(&src.to_string_lossy()).0;
        for refp in [format!("{}.slw", stem), format!("{}.stitch.slw", stem)] {
            let refp = PathBuf::from(refp);
            if refp.exists() {
                let name = refp.file_name().unwrap().to_string_lossy().to_string();
                out.push((src.clone(), refp, name));
            }
        }
    }
    let r = rebuild().join("reference");
    out.push((r.join("test.dxf"), r.join("test_default.slw"), "test_default.klw.slw".into()));
    out
}

#[test]
fn parity_with_the_original_program() {
    let mut failed = vec![];
    let cs = cases();
    assert_eq!(cs.len(), 15, "14 parity cases plus test_default");
    for (src, refp, name) in &cs {
        let bad = compare_with_reference(src, refp, name);
        let label = refp.file_name().unwrap().to_string_lossy().to_string();
        if bad.is_empty() {
            println!("PASS {}", label);
        } else {
            println!("FAIL {}: {}", label, bad.iter().take(5).cloned().collect::<Vec<_>>().join("; "));
            failed.push(label);
        }
    }
    assert!(failed.is_empty(), "failed: {:?}", failed);
}

#[test]
fn identical_to_the_python_writer() {
    let data = rebuild().join("tests").join("data").join("parity_python.json");
    let d: Value = serde_json::from_slice(&std::fs::read(&data).expect("run tests/dump_python_parity.py first")).unwrap();
    let stamp = d["stamp"].as_i64().unwrap();
    let mut failed = vec![];
    for c in d["cases"].as_array().unwrap() {
        let src = rebuild().join(c["src"].as_str().unwrap());
        let refp = rebuild().join(c["ref"].as_str().unwrap());
        let name = c["save_name"].as_str().unwrap();
        let (j, mine) = build(&src, &refp, name, Some(stamp));
        let want: Vec<Record> = c["records"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| {
                let v: Vec<u64> = r.as_array().unwrap().iter().map(|x| x.as_u64().unwrap()).collect();
                (v[0] as u16, v[1] as u16, v[2] as u32, v[3] as u32, v[4] as u32)
            })
            .collect();
        let order: Vec<i64> = c["order"].as_array().unwrap().iter().map(|x| x.as_i64().unwrap()).collect();
        assert_eq!(j.order, order, "sewing order of {}", name);
        // whole files, scrambled exactly as written to disk
        let enc = |r: &[Record]| {
            let body = machine::encode_records(r);
            let (h, b) = slw_container::encode(&body).unwrap();
            [h.to_vec(), b].concat()
        };
        if mine == want && enc(&mine) == enc(&want) {
            println!("SAME {} ({} records)", name, mine.len());
        } else {
            let i = (0..mine.len().max(want.len())).find(|&i| mine.get(i) != want.get(i)).unwrap_or(0);
            println!("DIFF {}: first at record {}: python {:?}, rust {:?}", name, i, want.get(i), mine.get(i));
            failed.push(name.to_string());
        }
    }
    assert!(failed.is_empty(), "differ from Python: {:?}", failed);
}

#[test]
fn reads_back_the_reference_file() {
    let data = std::fs::read(rebuild().join("reference").join("test_default.slw")).unwrap();
    let paths = machine::read_slw(&data).unwrap();
    assert_eq!(paths.len(), 3, "test_machine.py reads back 3 sewn paths");
}
