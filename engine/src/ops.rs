//! Editing operations on a Job. Every public function takes the job first and changes it in place. (port of engine/ops.py)
use crate::error::{Error, Res};
use crate::geom::{self, P};
use crate::importers::{self, RawPath};
use crate::model::{default_layer_settings, get_b, get_f, Instr, Job, Map};
use crate::py;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

fn op<T>(msg: &str) -> Res<T> {
    Err(Error::op(msg))
}

/// Positions (in job.shapes) of the shapes with these ids; error when none.
fn sel(job: &Job, ids: &[i64]) -> Res<Vec<usize>> {
    let set: HashSet<i64> = ids.iter().copied().collect();
    let v: Vec<usize> = job.shapes.iter().enumerate().filter(|(_, s)| set.contains(&s.id)).map(|(i, _)| i).collect();
    if v.is_empty() {
        return op("Select a shape first.");
    }
    Ok(v)
}

fn centre(job: &Job, idx: &[usize]) -> P {
    let (x0, y0, x1, y1) = geom::bbox(idx.iter().map(|&i| job.shapes[i].pts.as_slice()));
    ((x0 + x1) / 2.0, (y0 + y1) / 2.0)
}

fn shape_pos(job: &Job, sid: i64) -> Res<usize> {
    job.shapes.iter().position(|s| s.id == sid).ok_or(Error::Missing)
}

/// Python min(a, b) / max(a, b) for floats (first wins ties)
fn pmin(a: f64, b: f64) -> f64 {
    if b < a { b } else { a }
}
fn pmax(a: f64, b: f64) -> f64 {
    if b > a { b } else { a }
}

fn closed_path(s: &crate::model::Shape) -> Vec<P> {
    let mut p = s.pts.clone();
    if s.closed && !p.is_empty() {
        p.push(p[0]);
    }
    p
}

// ------------------------------------------------------------------ import / clean-up on open

pub fn load_paths(job: &mut Job, paths: Vec<RawPath>, settings: &Map, prefix_layer: &str) -> (usize, usize, usize) {
    let on = get_b(settings, "scale_on_open");
    let sx = if on { get_f(settings, "scale_x", 1.0) } else { 1.0 };
    let sy = if on { get_f(settings, "scale_y", 1.0) } else { 1.0 };
    let mut added = vec![];
    for p in paths {
        let mut pts: Vec<P> = p.pts.iter().map(|&(x, y)| (x * sx, y * sy)).collect();
        let closed = p.closed;
        if closed && pts.len() > 2 && geom::dist(pts[0], pts[pts.len() - 1]) < 1e-6 {
            pts.pop();
        }
        let lname = format!("{}{}", prefix_layer, if p.layer.is_empty() { "0" } else { p.layer.as_str() });
        let lid = job.ensure_layer(&lname);
        added.push(job.add_shape(&lid, pts, closed, None));
    }
    let (mut removed, mut joined) = (0, 0);
    if get_b(settings, "remove_overlap") {
        removed = remove_overlaps(job, &added);
    }
    if !get_b(settings, "no_join") {
        let set: HashSet<i64> = added.iter().copied().collect();
        let ids: Vec<i64> = job.shapes.iter().filter(|s| set.contains(&s.id)).map(|s| s.id).collect();
        joined = join_lines(job, &ids, 0.05, true).unwrap_or(0);
    }
    (added.len(), removed, joined)
}

fn key_bits(v: f64) -> u64 {
    if v == 0.0 { 0 } else { v.to_bits() }
}

pub fn remove_overlaps(job: &mut Job, ids: &[i64]) -> usize {
    let set: HashSet<i64> = ids.iter().copied().collect();
    let mut seen: HashSet<Vec<(u64, u64)>> = HashSet::new();
    let mut dup = vec![];
    for s in &job.shapes {
        if !set.contains(&s.id) {
            continue;
        }
        let mut k: Vec<P> = s.pts.iter().map(|&(x, y)| (py::round_n(x, 2), py::round_n(y, 2))).collect();
        k.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let key: Vec<(u64, u64)> = k.iter().map(|&(x, y)| (key_bits(x), key_bits(y))).collect();
        if seen.contains(&key) {
            dup.push(s.id);
        } else {
            seen.insert(key);
        }
    }
    for sid in &dup {
        job.remove_shape(*sid);
    }
    dup.len()
}

// ------------------------------------------------------------------ transforms

pub fn move_(job: &mut Job, ids: &[i64], dx: f64, dy: f64) -> Res<()> {
    for i in sel(job, ids)? {
        for p in job.shapes[i].pts.iter_mut() {
            *p = (p.0 + dx, p.1 + dy);
        }
    }
    Ok(())
}

pub fn rotate(job: &mut Job, ids: &[i64], angle: f64) -> Res<()> {
    let idx = sel(job, ids)?;
    let (cx, cy) = centre(job, &idx);
    for i in idx {
        job.shapes[i].pts = geom::rotate_pts(&job.shapes[i].pts, angle, cx, cy);
    }
    Ok(())
}

pub fn mirror(job: &mut Job, ids: &[i64], axis: &str) -> Res<()> {
    let idx = sel(job, ids)?;
    let (cx, cy) = centre(job, &idx);
    for i in idx {
        for p in job.shapes[i].pts.iter_mut() {
            *p = if axis == "h" { (2.0 * cx - p.0, p.1) } else { (p.0, 2.0 * cy - p.1) };
        }
    }
    Ok(())
}

/// Resize about `origin` (the fixed point: a bounding-box corner or edge when dragging a handle),
/// or about the centre of the shapes when None. Every point gets the same affine map, so the
/// point count, order, start point and closed flag stay as they are.
pub fn scale(job: &mut Job, ids: &[i64], sx: f64, sy: f64, origin: Option<P>) -> Res<()> {
    if !sx.is_finite() || !sy.is_finite() || sx.abs() < 1e-9 || sy.abs() < 1e-9 {
        return op("The size must be more than 0.");
    }
    let idx = sel(job, ids)?;
    let (cx, cy) = origin.unwrap_or_else(|| centre(job, &idx));
    for i in idx {
        for p in job.shapes[i].pts.iter_mut() {
            *p = (cx + (p.0 - cx) * sx, cy + (p.1 - cy) * sy);
        }
    }
    Ok(())
}

pub fn scale_all(job: &mut Job, sx: f64, sy: f64) {
    for s in job.shapes.iter_mut() {
        for p in s.pts.iter_mut() {
            *p = (p.0 * sx, p.1 * sy);
        }
    }
}

// ------------------------------------------------------------------ path direction / start / ends

pub fn reverse(job: &mut Job, ids: &[i64]) -> Res<()> {
    for i in sel(job, ids)? {
        let s = &mut job.shapes[i];
        if s.closed {
            if s.pts.len() > 1 {
                s.pts[1..].reverse();
            }
        } else {
            s.pts.reverse();
        }
        s.marks.clear();
    }
    Ok(())
}

pub fn set_start(job: &mut Job, sid: i64, x: f64, y: f64) -> Res<()> {
    let i = shape_pos(job, sid)?;
    let s = &mut job.shapes[i];
    let pts = s.pts.clone();
    if pts.is_empty() {
        return Err(Error::Unexpected("list index out of range".into()));
    }
    if !s.closed {
        if geom::dist(pts[pts.len() - 1], (x, y)) < geom::dist(pts[0], (x, y)) {
            s.pts.reverse();
        }
        return Ok(());
    }
    let mut ring = pts.clone();
    ring.push(pts[0]);
    let (d, _) = geom::nearest_on_path(&ring, (x, y));
    let (p, k) = geom::point_on_path(&ring, d);
    let mut body: Vec<P> = ring[k..ring.len() - 1].to_vec();
    body.extend_from_slice(&ring[..k]);
    if body.is_empty() || geom::dist(p, body[0]) > 1e-6 {
        body.insert(0, p);
    }
    // drop a vertex that coincides with the new start at the end
    if body.len() > 2 && geom::dist(body[body.len() - 1], p) < 1e-6 {
        body.pop();
    }
    s.pts = body;
    s.marks.clear();
    Ok(())
}

pub fn start_at(job: &mut Job, ids: &[i64], side: &str) -> Res<()> {
    let key: fn(P) -> f64 = match side {
        "top" => |p| -p.1,
        "bottom" => |p| p.1,
        "left" => |p| p.0,
        "right" => |p| -p.0,
        _ => return Err(Error::Missing),
    };
    for i in sel(job, ids)? {
        let (closed, pts, id) = (job.shapes[i].closed, job.shapes[i].pts.clone(), job.shapes[i].id);
        if pts.is_empty() {
            return Err(Error::Unexpected("min() arg is an empty sequence".into()));
        }
        if closed {
            let b = pts[py::argmin(pts.len(), |k| key(pts[k]))];
            set_start(job, id, b.0, b.1)?;
        } else if key(pts[pts.len() - 1]) < key(pts[0]) {
            job.shapes[i].pts.reverse();
        }
    }
    Ok(())
}

fn extend(pts: Vec<P>, amount: f64, at_start: bool) -> Res<Vec<P>> {
    if pts.len() < 2 || amount.abs() < 1e-9 {
        return Ok(pts);
    }
    if at_start {
        let mut r: Vec<P> = pts.into_iter().rev().collect();
        r = extend(r, amount, false)?;
        r.reverse();
        return Ok(r);
    }
    if amount > 0.0 {
        let (a, b) = (pts[pts.len() - 2], pts[pts.len() - 1]);
        let l = geom::dist(a, b);
        if l < geom::EPS {
            return Ok(pts);
        }
        let mut out = pts[..pts.len() - 1].to_vec();
        out.push((b.0 + (b.0 - a.0) / l * amount, b.1 + (b.1 - a.1) / l * amount));
        return Ok(out);
    }
    let total = geom::path_length(&pts);
    let keep = total + amount;
    if keep <= 0.01 {
        return op("That would remove the whole line.");
    }
    let mut out = vec![pts[0]];
    let mut acc = 0.0;
    for i in 1..pts.len() {
        let seg = geom::dist(pts[i - 1], pts[i]);
        if acc + seg >= keep {
            let t = if seg > geom::EPS { (keep - acc) / seg } else { 0.0 };
            out.push((pts[i - 1].0 + (pts[i].0 - pts[i - 1].0) * t, pts[i - 1].1 + (pts[i].1 - pts[i - 1].1) * t));
            return Ok(out);
        }
        out.push(pts[i]);
        acc += seg;
    }
    Ok(out)
}

pub fn extend_ends(job: &mut Job, ids: &[i64], start_mm: f64, end_mm: f64) -> Res<()> {
    for i in sel(job, ids)? {
        let pts = closed_path(&job.shapes[i]);
        let pts = extend(pts, start_mm, true)?;
        let pts = extend(pts, end_mm, false)?;
        let s = &mut job.shapes[i];
        s.pts = pts;
        s.closed = false;
        s.marks.clear();
    }
    Ok(())
}

// ------------------------------------------------------------------ points

pub fn set_points(job: &mut Job, sid: i64, pts: &Value, closed: &Value) -> Res<()> {
    let i = shape_pos(job, sid)?;
    let list = match pts {
        Value::Array(a) => a,
        v if !py::truthy(Some(v)) => return op("A shape needs at least one point."),
        _ => return Err(Error::Unexpected("cannot unpack the points".into())),
    };
    if list.is_empty() {
        return op("A shape needs at least one point.");
    }
    let mut out = vec![];
    for p in list {
        let xy = p.as_array().filter(|a| a.len() == 2).ok_or_else(|| Error::Unexpected("cannot unpack a point".into()))?;
        let f = |v: &Value| py::to_float(v).ok_or_else(|| Error::op(format!("could not convert string to float: {}", py::py_repr(v))));
        out.push((f(&xy[0])?, f(&xy[1])?));
    }
    let s = &mut job.shapes[i];
    s.closed = py::truthy(Some(closed)) && list.len() > 2;
    s.pts = out;
    s.marks.clear();
    Ok(())
}

/// Python list slice a[lo:hi]
fn pslice<T: Clone>(a: &[T], lo: i64, hi: Option<i64>) -> Vec<T> {
    let n = a.len() as i64;
    let c = |v: i64| if v < 0 { (n + v).max(0) } else { v.min(n) };
    let (l, h) = (c(lo), c(hi.unwrap_or(n)));
    if h <= l { vec![] } else { a[l as usize..h as usize].to_vec() }
}

pub fn split_at(job: &mut Job, sid: i64, index: i64) -> Res<Vec<i64>> {
    let i = shape_pos(job, sid)?;
    let pts = job.shapes[i].pts.clone();
    if job.shapes[i].closed {
        let mut ring = pslice(&pts, index, None);
        ring.extend(pslice(&pts, 0, Some(index + 1)));
        job.shapes[i].pts = ring;
        job.shapes[i].closed = false;
        return Ok(vec![sid]);
    }
    if index <= 0 || index >= pts.len() as i64 - 1 {
        return op("Pick a point in the middle of the line to split it.");
    }
    job.shapes[i].pts = pts[..=index as usize].to_vec();
    let pos = job.order.iter().position(|&o| o == sid).map(|p| p + 1);
    let layer = job.shapes[i].layer.clone();
    let n = job.add_shape(&layer, pts[index as usize..].to_vec(), false, pos);
    Ok(vec![sid, n])
}

pub fn merge_points(job: &mut Job, ids: &[i64], tol: f64) -> Res<usize> {
    let mut n = 0;
    for i in sel(job, ids)? {
        let s = &mut job.shapes[i];
        if s.pts.is_empty() {
            return Err(Error::Unexpected("list index out of range".into()));
        }
        let mut out = vec![s.pts[0]];
        for &p in &s.pts[1..] {
            if geom::dist(out[out.len() - 1], p) < tol {
                n += 1;
                continue;
            }
            out.push(p);
        }
        if s.closed && out.len() > 2 && geom::dist(out[out.len() - 1], out[0]) < tol {
            out.pop();
            n += 1;
        }
        s.pts = out;
    }
    Ok(n)
}

pub fn delete_short(job: &mut Job, ids: &[i64], min_len: f64) -> Res<usize> {
    let gone: Vec<i64> = sel(job, ids)?
        .into_iter()
        .map(|i| &job.shapes[i])
        .filter(|s| s.pts.len() > 1 && geom::path_length(&closed_path(s)) < min_len)
        .map(|s| s.id)
        .collect();
    for sid in &gone {
        job.remove_shape(*sid);
    }
    Ok(gone.len())
}

/// Join open shapes on the same layer whose ends meet within tol mm.
///
/// Same result as the Python version (which tries every pair again after each join), but finds the
/// candidates through a grid of line ends so large drawings stay fast.
pub fn join_lines(job: &mut Job, ids: &[i64], tol: f64, quiet: bool) -> Res<usize> {
    let idset: HashSet<i64> = ids.iter().copied().collect();
    let mut joined = 0;
    let cell = if tol > 0.0 { tol * 1.0001 + 1e-9 } else { 1e-9 };
    let cellf = |p: P| -> (i64, i64) { ((p.0 / cell).floor() as i64, (p.1 / cell).floor() as i64) };
    if tol >= 0.0 {
        loop {
            // open shapes in job order, and a grid of their ends
            let opens: Vec<usize> = job
                .shapes
                .iter()
                .enumerate()
                .filter(|(_, s)| idset.contains(&s.id) && !s.closed && s.pts.len() > 1)
                .map(|(i, _)| i)
                .collect();
            let mut grid: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
            for (k, &si) in opens.iter().enumerate() {
                let pts = &job.shapes[si].pts;
                for e in [pts[0], pts[pts.len() - 1]] {
                    let v = grid.entry(cellf(e)).or_default();
                    if v.last() != Some(&k) {
                        v.push(k);
                    }
                }
            }
            let mut found: Option<(usize, usize, Vec<P>)> = None;
            'outer: for (ka, &ai) in opens.iter().enumerate() {
                let a = &job.shapes[ai];
                let pa = &a.pts;
                let mut cand: Vec<usize> = vec![];
                for e in [pa[0], pa[pa.len() - 1]] {
                    let (cx, cy) = cellf(e);
                    for gx in cx - 1..=cx + 1 {
                        for gy in cy - 1..=cy + 1 {
                            if let Some(v) = grid.get(&(gx, gy)) {
                                cand.extend(v.iter().copied());
                            }
                        }
                    }
                }
                cand.sort_unstable();
                cand.dedup();
                for kb in cand {
                    if kb == ka {
                        continue;
                    }
                    let b = &job.shapes[opens[kb]];
                    if a.layer != b.layer {
                        continue;
                    }
                    let pb = &b.pts;
                    let (a0, a1, b0, b1) = (pa[0], pa[pa.len() - 1], pb[0], pb[pb.len() - 1]);
                    let ds = [geom::dist(a1, b0), geom::dist(a1, b1), geom::dist(a0, b1), geom::dist(a0, b0)];
                    let c = py::argmin(4, |i| ds[i]);
                    if ds[c] <= tol {
                        let pts: Vec<P> = match c {
                            0 => pa.iter().chain(pb[1..].iter()).copied().collect(),
                            1 => pa.iter().copied().chain(pb.iter().rev().skip(1).copied()).collect(),
                            2 => pb.iter().chain(pa[1..].iter()).copied().collect(),
                            _ => pb.iter().rev().copied().chain(pa[1..].iter().copied()).collect(),
                        };
                        found = Some((ai, opens[kb], pts));
                        break 'outer;
                    }
                }
            }
            let Some((ai, bi, pts)) = found else { break };
            let bid = job.shapes[bi].id;
            let a = &mut job.shapes[ai];
            if pts.len() > 2 && geom::dist(pts[0], pts[pts.len() - 1]) <= tol {
                a.pts = pts[..pts.len() - 1].to_vec();
                a.closed = true;
            } else {
                a.pts = pts;
            }
            a.marks.clear();
            job.remove_shape(bid);
            joined += 1;
        }
    }
    if joined == 0 && !quiet {
        return op("No line ends were close enough to join.");
    }
    Ok(joined)
}

// ------------------------------------------------------------------ add / copy / delete / layers

pub fn delete(job: &mut Job, ids: &[i64]) -> Res<()> {
    let gone: Vec<i64> = sel(job, ids)?.into_iter().map(|i| job.shapes[i].id).collect();
    for sid in gone {
        job.remove_shape(sid);
    }
    let have: HashSet<i64> = job.shapes.iter().map(|s| s.id).collect();
    for k in ["r1", "r2"] {
        if let Some(v) = job.refs.get(k) {
            if !v.is_null() {
                let keep = match v.as_i64().or_else(|| v.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64)) {
                    Some(i) => have.contains(&i),
                    None => false,
                };
                if !keep {
                    job.refs.shift_remove(k);
                }
            }
        }
    }
    Ok(())
}

pub fn duplicate(job: &mut Job, ids: &[i64], dx: f64, dy: f64, mirror_h: bool, mirror_v: bool) -> Res<Vec<i64>> {
    let idx = sel(job, ids)?;
    let mut new = vec![];
    for i in idx {
        let s = job.shapes[i].clone();
        let pts = s.pts.iter().map(|&(x, y)| (x + dx, y + dy)).collect();
        let n = job.add_shape(&s.layer, pts, s.closed, None);
        job.shape_mut(n).unwrap().marks = s.marks.clone();
        new.push(n);
    }
    if mirror_h {
        mirror(job, &new, "h")?;
    }
    if mirror_v {
        mirror(job, &new, "v")?;
    }
    Ok(new)
}

#[allow(clippy::too_many_arguments)]
pub fn add_shape(job: &mut Job, kind: &str, x: f64, y: f64, size: f64, layer_id: Option<String>, w: Option<f64>, h: Option<f64>) -> Res<i64> {
    let (pts, closed): (Vec<P>, bool) = match kind {
        "point" => (vec![(x, y)], false),
        "line" => (vec![(x, y), (x + size, y)], false),
        "rect" => {
            let w = w.filter(|v| *v != 0.0).unwrap_or(size);
            let h = h.filter(|v| *v != 0.0).unwrap_or(size);
            (vec![(x, y), (x + w, y), (x + w, y + h), (x, y + h)], true)
        }
        "circle" => {
            let mut p = geom::arc_points(x, y, size, 0.0, 360.0);
            p.pop();
            (p, true)
        }
        _ => return op("Unknown shape type."),
    };
    let layer_id = match layer_id.filter(|l| !l.is_empty()) {
        Some(l) => l,
        None => match job.layers.first() {
            Some(l) => l.id.clone(),
            None => job.ensure_layer("Layer1"),
        },
    };
    Ok(job.add_shape(&layer_id, pts, closed, None))
}

pub fn set_layer(job: &mut Job, ids: &[i64], layer_id: &str) -> Res<()> {
    job.layer(layer_id).ok_or(Error::Missing)?;
    for i in sel(job, ids)? {
        job.shapes[i].layer = layer_id.to_string();
    }
    Ok(())
}

fn py_lower(s: &str) -> String {
    s.to_lowercase()
}

pub fn add_layer(job: &mut Job, name: &str) -> String {
    let names: HashSet<String> = job.layers.iter().map(|l| py_lower(&l.name)).collect();
    let mut name = name.to_string();
    if name.is_empty() || names.contains(&py_lower(&name)) {
        let fmt = |n: usize| if name.is_empty() { format!("Layer{}", n) } else { format!("{} {}", name, n) };
        let mut n = job.layers.len() + 1;
        while names.contains(&py_lower(&fmt(n))) {
            n += 1;
        }
        name = fmt(n);
    }
    job.ensure_layer(&name)
}

pub fn update_layer(job: &mut Job, lid: &str, fields: &Map) -> Res<()> {
    let defaults = default_layer_settings();
    let l = job.layer_mut(lid).ok_or(Error::Missing)?;
    if let Some(v) = fields.get("name") {
        l.name = match v {
            Value::String(s) => s.clone(),
            o => py::py_str(o),
        };
    }
    if let Some(v) = fields.get("color") {
        l.color = match v {
            Value::String(s) => s.clone(),
            o => py::py_str(o),
        };
    }
    if let Some(v) = fields.get("needle") {
        l.needle = py::to_int(v).unwrap_or(l.needle);
    }
    if let Some(v) = fields.get("output") {
        l.output = py::truthy(Some(v));
    }
    if let Some(s) = fields.get("settings") {
        match s {
            Value::Object(m) => {
                for (k, v) in m {
                    if defaults.contains_key(k) {
                        l.settings.insert(k.clone(), v.clone());
                    }
                }
            }
            Value::Null => return Err(Error::Unexpected("'NoneType' object has no attribute 'items'".into())),
            _ => return Err(Error::Unexpected("settings must be a dict".into())),
        }
    }
    Ok(())
}

/// Put the selected shapes into a new group (layer) with its own needle; returns the group id.
pub fn make_group(job: &mut Job, ids: &[i64], name: &str, needle: &Value, color: &Value) -> Res<String> {
    let idx = sel(job, ids)?;
    let src_id = job.shapes[idx[0]].layer.clone();
    let src_settings = job.layer(&src_id).ok_or(Error::Missing)?.settings.clone();
    let lid = add_layer(job, name);
    let nd = if py::truthy(Some(needle)) { py::to_int(needle).ok_or_else(|| Error::op("invalid needle"))? } else { 1 };
    {
        let l = job.layer_mut(&lid).unwrap();
        l.settings = src_settings;
        l.needle = 1.max(3.min(nd));
        if py::truthy(Some(color)) {
            l.color = match color {
                Value::String(s) => s.clone(),
                o => py::py_str(o),
            };
        }
    }
    for i in idx {
        job.shapes[i].layer = lid.clone();
    }
    // keep the new group where its shapes were in the sewing order
    let pos = job.layers.iter().position(|l| l.id == lid).unwrap();
    let l = job.layers.remove(pos);
    let sp = job.layers.iter().position(|l| l.id == src_id).ok_or(Error::Missing)?;
    job.layers.insert(sp + 1, l);
    Ok(lid)
}

/// Remove a group but keep its shapes: they move to the group above (or below).
pub fn ungroup(job: &mut Job, lid: &str) -> Res<String> {
    if job.layers.len() <= 1 {
        return op("This is the only group; there is nowhere to move its shapes.");
    }
    let i = job.layers.iter().position(|l| l.id == lid).ok_or(Error::Missing)?;
    let target = if i > 0 { job.layers[i - 1].id.clone() } else { job.layers[i + 1].id.clone() };
    for s in job.shapes.iter_mut() {
        if s.layer == lid {
            s.layer = target.clone();
        }
    }
    job.layers.retain(|l| l.id != lid);
    if matches!(job.refs.get("align"), Some(Value::String(a)) if a == lid) {
        job.refs.shift_remove("align");
    }
    Ok(target)
}

pub fn remove_empty_groups(job: &mut Job) {
    let used: HashSet<&str> = job.shapes.iter().map(|s| s.layer.as_str()).collect();
    let keep: Vec<_> = job.layers.iter().filter(|l| used.contains(l.id.as_str())).cloned().collect();
    if !keep.is_empty() && keep.len() < job.layers.len() {
        job.layers = keep;
    }
}

pub fn move_group(job: &mut Job, lid: &str, delta: i64) -> Res<()> {
    let i = job.layers.iter().position(|l| l.id == lid).ok_or(Error::Missing)? as i64;
    let j = 0.max((job.layers.len() as i64 - 1).min(i + delta));
    let l = job.layers.remove(i as usize);
    job.layers.insert(j as usize, l);
    Ok(())
}

pub fn copy_layer_settings(job: &mut Job, lid: &str) -> Res<()> {
    let src = job.layer(lid).ok_or(Error::Missing)?.settings.clone();
    for l in job.layers.iter_mut() {
        l.settings = src.clone();
    }
    Ok(())
}

pub fn delete_layer(job: &mut Job, lid: &str) -> Res<()> {
    if job.layers.len() <= 1 {
        return op("A job needs at least one layer.");
    }
    let gone: Vec<i64> = job.shapes.iter().filter(|s| s.layer == lid).map(|s| s.id).collect();
    for sid in gone {
        job.remove_shape(sid);
    }
    job.layers.retain(|l| l.id != lid);
    Ok(())
}

// ------------------------------------------------------------------ sections (zigzag / back-tack / special)

pub fn add_mark(job: &mut Job, sid: i64, kind: &Value, a: f64, b: f64, params: &Value) -> Res<()> {
    let i = shape_pos(job, sid)?;
    let s = &mut job.shapes[i];
    if s.pts.is_empty() {
        return Err(Error::Unexpected("list index out of range".into()));
    }
    let total = geom::path_length(&closed_path(s));
    let (a2, b2) = (pmax(0.0, pmin(a, b)), pmin(total, pmax(a, b)));
    if b2 - a2 < 0.1 {
        return op("The section must be longer than 0.1 mm.");
    }
    let mut m = Map::new();
    m.insert("kind".into(), kind.clone());
    m.insert("a".into(), py::num(a2));
    m.insert("b".into(), py::num(b2));
    if let Value::Object(p) = params {
        for (k, v) in p {
            if matches!(k.as_str(), "width" | "span" | "shape" | "start" | "equal") {
                m.insert(k.clone(), v.clone());
            }
        }
    }
    s.marks.push(m);
    Ok(())
}

pub fn clear_marks(job: &mut Job, ids: &[i64]) -> Res<()> {
    for i in sel(job, ids)? {
        job.shapes[i].marks.clear();
    }
    Ok(())
}

// ------------------------------------------------------------------ reference points

pub fn set_ref(job: &mut Job, which: &str, sid: Option<i64>) -> Res<()> {
    match which {
        "r1" | "r2" => match sid {
            None => {
                job.refs.shift_remove(which);
            }
            Some(id) => {
                job.shape(id).ok_or(Error::Missing)?;
                job.refs.insert(which.into(), json!(id));
            }
        },
        "align" => match sid {
            None => {
                job.refs.shift_remove("align");
            }
            Some(id) => {
                let l = job.shape(id).ok_or(Error::Missing)?.layer.clone();
                job.refs.insert("align".into(), json!(l));
            }
        },
        _ => {}
    }
    Ok(())
}

// ------------------------------------------------------------------ sewing order

pub fn reorder(job: &mut Job, ids: &[i64]) {
    let known: HashSet<i64> = job.order.iter().copied().collect();
    let ids: Vec<i64> = ids.iter().copied().filter(|i| known.contains(i)).collect();
    let set: HashSet<i64> = ids.iter().copied().collect();
    let rest: Vec<i64> = job.order.iter().copied().filter(|i| !set.contains(i)).collect();
    job.order = ids.into_iter().chain(rest).collect();
}

fn cmp_f(a: f64, b: f64) -> std::cmp::Ordering {
    a.partial_cmp(&b).unwrap_or(std::cmp::Ordering::Equal)
}

pub fn sort_order(job: &mut Job, direction: &str, row_spacing: f64, by_end: bool) -> Res<()> {
    let idx = job.shape_index();
    let mut shapes = vec![];
    for sid in &job.order {
        let i = *idx.get(sid).ok_or(Error::Missing)?;
        let s = &job.shapes[i];
        if s.pts.is_empty() {
            return Err(Error::Unexpected("list index out of range".into()));
        }
        let p = if by_end { s.pts[s.pts.len() - 1] } else { s.pts[0] };
        shapes.push((s.id, p));
    }
    let rs = pmax(0.01, row_spacing);
    let rows_by = |coord: fn(P) -> f64| -> Vec<(i64, Vec<(i64, P)>)> {
        let mut rows: Vec<(i64, Vec<(i64, P)>)> = vec![];
        for &(id, p) in &shapes {
            let k = py::round_int(coord(p) / rs);
            match rows.iter_mut().find(|(rk, _)| *rk == k) {
                Some((_, v)) => v.push((id, p)),
                None => rows.push((k, vec![(id, p)])),
            }
        }
        rows
    };
    let mut out: Vec<i64> = vec![];
    if direction == "tb" || direction == "bt" {
        let mut rows = rows_by(|p| p.1);
        rows.sort_by(|a, b| if direction == "tb" { b.0.cmp(&a.0) } else { a.0.cmp(&b.0) });
        for (i, (_, mut row)) in rows.into_iter().enumerate() {
            // serpentine rows
            if i % 2 == 1 {
                row.sort_by(|a, b| cmp_f(b.1 .0, a.1 .0));
            } else {
                row.sort_by(|a, b| cmp_f(a.1 .0, b.1 .0));
            }
            out.extend(row.into_iter().map(|(id, _)| id));
        }
    } else {
        let mut cols = rows_by(|p| p.0);
        cols.sort_by(|a, b| if direction == "rl" { b.0.cmp(&a.0) } else { a.0.cmp(&b.0) });
        for (i, (_, mut col)) in cols.into_iter().enumerate() {
            if i % 2 == 0 {
                col.sort_by(|a, b| cmp_f(b.1 .1, a.1 .1));
            } else {
                col.sort_by(|a, b| cmp_f(a.1 .1, b.1 .1));
            }
            out.extend(col.into_iter().map(|(id, _)| id));
        }
    }
    job.order = out;
    Ok(())
}

/// Sew group by group, in the order of the group list (keeps the order inside each group).
pub fn order_by_group(job: &mut Job) -> Res<()> {
    let rank: HashMap<&str, usize> = job.layers.iter().enumerate().map(|(i, l)| (l.id.as_str(), i)).collect();
    let idx = job.shape_index();
    let mut keyed = vec![];
    for &sid in &job.order {
        let i = *idx.get(&sid).ok_or(Error::Missing)?;
        keyed.push((rank.get(job.shapes[i].layer.as_str()).copied().unwrap_or(0), sid));
    }
    keyed.sort_by_key(|k| k.0);
    job.order = keyed.into_iter().map(|k| k.1).collect();
    Ok(())
}

/// Shortest-travel order: always go to the nearest unsewn shape.
pub fn nearest_order(job: &mut Job) -> Res<()> {
    let idx = job.shape_index();
    let mut left: Vec<usize> = vec![];
    for sid in &job.order {
        let i = *idx.get(sid).ok_or(Error::Missing)?;
        if job.shapes[i].pts.is_empty() {
            return Err(Error::Unexpected("list index out of range".into()));
        }
        left.push(i);
    }
    let mut pos: P = (0.0, 0.0);
    let mut out = vec![];
    while !left.is_empty() {
        let k = py::argmin(left.len(), |k| geom::dist(pos, job.shapes[left[k]].pts[0]));
        let s = &job.shapes[left.remove(k)];
        out.push(s.id);
        pos = if !s.closed { s.pts[s.pts.len() - 1] } else { s.pts[0] };
    }
    job.order = out;
    Ok(())
}

// ------------------------------------------------------------------ program instructions added by the user

pub const INSTRUCTIONS: [&str; 16] = [
    "Speed", "Delay", "Output IO", "Input IO", "Z axis", "U axis", "Label", "Loop", "Main shaft position",
    "Thread trim", "Presser foot up", "Presser foot down", "XY offset move", "Back to origin", "Pause", "Needle change",
];

pub fn insert_instruction(job: &mut Job, before: Value, name: &str, value: &Value) -> Res<i64> {
    if !INSTRUCTIONS.contains(&name) {
        return op("Unknown instruction.");
    }
    let iid = job.next_id();
    job.program_extra.push(Instr { id: iid, before, name: name.into(), value: py::py_str(value), extra: Map::new() });
    Ok(iid)
}

pub fn move_instruction(job: &mut Job, iid: &Value, delta: i64) -> Res<()> {
    let Some(k) = job.program_extra.iter().position(|x| py::py_eq(&json!(x.id), iid)) else {
        return op("Select an instruction you added.");
    };
    let mut anchors: Vec<Value> = job.order.iter().map(|&i| json!(i)).collect();
    anchors.push(json!("end"));
    let n = anchors.len() as i64;
    let before = &job.program_extra[k].before;
    let pos = anchors.iter().position(|a| py::py_eq(a, before)).map(|p| p as i64).unwrap_or(n - 1);
    job.program_extra[k].before = anchors[0.max((n - 1).min(pos + delta)) as usize].clone();
    Ok(())
}

pub fn delete_instruction(job: &mut Job, iid: &Value) {
    job.program_extra.retain(|x| !py::py_eq(&json!(x.id), iid));
}

// ------------------------------------------------------------------ insert another file

pub fn insert_file(job: &mut Job, path: &str, settings: &Map) -> Res<(usize, usize, usize)> {
    let paths = importers::read_any(path, get_f(settings, "dpi", 1016.0))?;
    Ok(load_paths(job, paths, settings, ""))
}
