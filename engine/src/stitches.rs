//! Turn shapes into needle positions. (port of engine/stitches.py)
//!
//! A stitched shape is a list of points (mm, y up) plus a flag string with one character per point:
//!   s = normal stitch   b = back-tack   d = dense stitch   w = slow (corner)   z = zigzag   x = special length
//!   p = shape collapsed to a single point   r = closed-shape reinforcement / overlap
use crate::error::{Error, Res};
use crate::geom::{self, P};
use crate::model::{get_b, get_bd, get_f, get_i, Job, Map, Shape};
use crate::py;
use serde_json::Value;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::hash::{Hash, Hasher};

pub type Stitched = (Vec<P>, String);
pub type StitchMap = HashMap<i64, Stitched>;

/// Most needle positions a job may have. More means a wrong size or setting, and would run out of memory.
pub const MAX_STITCHES: usize = 2_000_000;
/// Farthest a point may be from the origin (mm); machine files keep positions in 32 bits of micrometres.
pub const MAX_COORD: f64 = 1_000_000.0;

pub fn too_many_stitches() -> Error {
    Error::op("This job would have more than 2,000,000 needle positions. Check the size of the drawing and the stitch settings.")
}

pub fn too_large() -> Error {
    Error::op("The drawing is too large: every point must be within 1,000,000 mm of the origin.")
}

/// Err when `n` more positions (a float, so huge counts do not overflow) would pass MAX_STITCHES.
fn budget(n: f64) -> Res<()> {
    if n <= MAX_STITCHES as f64 { Ok(()) } else { Err(too_many_stitches()) }
}

fn cum_of(pts: &[P]) -> Vec<f64> {
    let mut out = Vec::with_capacity(pts.len());
    out.push(0.0);
    for i in 1..pts.len() {
        let v = out[i - 1] + geom::dist(pts[i - 1], pts[i]);
        out.push(v);
    }
    out
}

/// Point at distance d along a polyline with cumulative lengths cum.
fn at(pts: &[P], cum: &[f64], d: f64) -> P {
    if d <= 0.0 {
        return pts[0];
    }
    if d >= cum[cum.len() - 1] {
        return pts[pts.len() - 1];
    }
    let (mut lo, mut hi) = (0usize, cum.len() - 1);
    while hi - lo > 1 {
        let mid = (lo + hi) / 2;
        if cum[mid] <= d {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let seg = cum[hi] - cum[lo];
    let t = if seg < geom::EPS { 0.0 } else { (d - cum[lo]) / seg };
    let (a, b) = (pts[lo], pts[hi]);
    (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t)
}

fn tangent(pts: &[P], cum: &[f64], d: f64) -> P {
    let e = 0.05;
    let a = at(pts, cum, 0.0f64.max(d - e));
    let b = at(pts, cum, cum[cum.len() - 1].min(d + e));
    let l = geom::dist(a, b);
    if l < geom::EPS {
        return (1.0, 0.0);
    }
    ((b.0 - a.0) / l, (b.1 - a.1) / l)
}

/// Distances along the path where the direction turns by at least `angle` degrees.
pub fn corner_distances(pts: &[P], closed: bool, angle: f64) -> Vec<f64> {
    let cum = cum_of(pts);
    let n = pts.len();
    let mut out = vec![];
    for i in 1..n.saturating_sub(1) {
        if geom::turn_angle(pts[i - 1], pts[i], pts[i + 1]) >= angle {
            out.push(cum[i]);
        }
    }
    if closed && n > 3 && geom::dist(pts[0], pts[n - 1]) < 1e-6 && geom::turn_angle(pts[n - 2], pts[0], pts[1]) >= angle {
        out.push(0.0);
    }
    out
}

pub fn path_of(shape: &Shape) -> Vec<P> {
    let mut pts = shape.pts.clone();
    if shape.closed && pts.len() > 2 && geom::dist(pts[0], pts[pts.len() - 1]) > 1e-6 {
        pts.push(pts[0]);
    }
    pts
}

pub fn mark_kind(m: &Map) -> &str {
    m.get("kind").and_then(|v| v.as_str()).unwrap_or("")
}

pub fn mark_ab(m: &Map) -> (f64, f64) {
    (get_f(m, "a", 0.0), get_f(m, "b", 0.0))
}

fn in_marks<'a>(marks: &'a [Map], d: f64, kind: &str) -> Option<&'a Map> {
    marks.iter().find(|m| {
        let (a, b) = mark_ab(m);
        mark_kind(m) == kind && a <= d && d <= b
    })
}

/// Equal-length stitches between break points (corners and section marks).
fn base_stitches(pts: &[P], ls: &Map, marks: &[Map], corners: &[f64]) -> Res<(Vec<(P, u8)>, Vec<f64>)> {
    let cum = cum_of(pts);
    let total = cum[cum.len() - 1];
    let l = 0.1f64.max(get_f(ls, "stitch_len", 0.0));
    let mut set: Vec<f64> = vec![0.0, total];
    set.extend(corners.iter().copied().filter(|&c| 0.0 < c && c < total));
    for m in marks {
        let (a, b) = mark_ab(m);
        for v in [a, b] {
            if 0.0 < v && v < total {
                set.push(v);
            }
        }
    }
    // a Python set of floats, sorted
    let mut breaks: Vec<f64> = vec![];
    for v in set {
        if !breaks.iter().any(|&b| b == v) {
            breaks.push(v);
        }
    }
    breaks.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mut out: Vec<(P, u8)> = vec![(pts[0], b's')];
    let mut k: i64 = 0;
    for w in breaks.windows(2) {
        let (a, b) = (w[0], w[1]);
        if b - a < 1e-6 {
            continue;
        }
        let mid = (a + b) / 2.0;
        let (mut flag, mut step) = (b's', l);
        if in_marks(marks, mid, "special").is_some() {
            flag = b'x';
            step = match ls.get("special_len") {
                None => 0.0,
                Some(v) if !py::truthy(Some(v)) => 0.0,
                Some(v) => py::to_float(v).unwrap_or(0.0),
            };
        }
        if step <= 0.0 {
            // special part that is not converted: keep the drawn points
            for (i, &c) in cum.iter().enumerate() {
                if a < c && c < b {
                    out.push((pts[i], flag));
                }
            }
            out.push((at(pts, &cum, b), flag));
            continue;
        }
        if get_b(ls, "double_on") {
            // alternate the normal length with the double length on odd / even stitches
            let mut d = a;
            while b - d > 1e-6 {
                budget(out.len() as f64)?;
                k += 1;
                let usev = (k % 2 == 1 && get_b(ls, "double_odd")) || (k % 2 == 0 && get_b(ls, "double_even"));
                let s = if usev { get_f(ls, "double_len", step) } else { step };
                // a double length of 0 or less would never get to the end: use the normal length
                let s = if s > 0.0 { s } else { step };
                d = b.min(d + s);
                if b - d < s * 0.35 {
                    d = b;
                }
                out.push((at(pts, &cum, d), flag));
            }
            continue;
        }
        budget(out.len() as f64 + (b - a) / step)?;
        let n = std::cmp::max(1, py::round_int((b - a) / step));
        for i in 1..=n {
            out.push((at(pts, &cum, a + (b - a) * i as f64 / n as f64), flag));
        }
    }
    Ok((out, cum))
}

/// Split the given stitch intervals (index i = between point i and i+1) into `factor` parts.
fn densify(st: Vec<(P, u8)>, intervals: &HashSet<i64>, factor: f64, flag: u8) -> Res<Vec<(P, u8)>> {
    if intervals.is_empty() || factor <= 1.0 {
        return Ok(st);
    }
    let f = std::cmp::max(2, py::round_int(factor));
    budget(st.len() as f64 + intervals.len() as f64 * (f as f64 - 1.0))?;
    let mut out = vec![st[0]];
    for i in 1..st.len() {
        let (a, b) = (st[i - 1].0, st[i].0);
        if intervals.contains(&((i - 1) as i64)) {
            for j in 1..f {
                let t = j as f64 / f as f64;
                out.push(((a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t), flag));
            }
            out.push((b, if st[i].1 == b's' { flag } else { st[i].1 }));
        } else {
            out.push(st[i]);
        }
    }
    Ok(out)
}

fn zigzag(pts: &[P], cum: &[f64], m: &Map) -> Res<Vec<(P, u8)>> {
    let w = get_f(m, "width", 2.4) / 2.0;
    let span = 0.2f64.max(get_f(m, "span", 2.0));
    let shape = m.get("shape").map(|v| v.as_str().unwrap_or("?")).unwrap_or("V");
    let start = m.get("start").map(|v| v.as_str().unwrap_or("?")).unwrap_or("middle");
    let (a, b) = mark_ab(m);
    let mut out = vec![];
    let mut side: f64 = if start != "left" { 1.0 } else { -1.0 };
    if start == "right" {
        side = -1.0;
    }
    let inc = if shape == "V" { span / 2.0 } else { span / 4.0 };
    budget((b - a) / inc)?;
    let mut seq = vec![];
    let mut d = a;
    while d <= b + 1e-6 {
        seq.push(d);
        d += inc;
    }
    for (i, &d) in seq.iter().enumerate() {
        let p = at(pts, cum, d);
        let (tx, ty) = tangent(pts, cum, d);
        let (nx, ny) = (-ty, tx);
        let mut off;
        if shape == "W" && i % 2 == 0 {
            off = 0.0;
        } else {
            off = w * side;
            side = -side;
        }
        if start == "middle" && i == 0 {
            off = 0.0;
        }
        out.push(((p.0 + nx * off, p.1 + ny * off), b'z'));
    }
    Ok(out)
}

/// Back-and-forth over the first k+1 points `reps` times; ends where it started.
fn tack(path_pts: &[P], k: i64, reps: i64, flag: u8) -> Res<Vec<(P, u8)>> {
    let end = (k.saturating_add(1).max(0) as usize).min(path_pts.len());
    let seg = &path_pts[..end];
    if seg.len() < 2 || reps <= 0 {
        return Ok(vec![]);
    }
    budget(reps as f64 * 2.0 * seg.len() as f64)?;
    let mut out = vec![];
    for _ in 0..reps {
        out.extend(seg[1..].iter().map(|&p| (p, flag)));
        out.extend(seg[..seg.len() - 1].iter().rev().map(|&p| (p, flag)));
    }
    Ok(out)
}

fn nearest_index(st: &[(P, u8)], p: P) -> usize {
    py::argmin(st.len(), |i| geom::dist(st[i].0, p))
}

/// Python slice bounds for a[lo:hi] with possibly out-of-range values
fn sl(len: usize, lo: i64, hi: i64) -> (usize, usize) {
    let c = |v: i64| -> usize {
        if v < 0 {
            (len as i64 + v).max(0) as usize
        } else {
            (v as usize).min(len)
        }
    };
    let (a, b) = (c(lo), c(hi));
    (a, b.max(a))
}

/// (points, flags) for one shape with layer settings ls and job settings j.
/// Err for a shape too large to stitch (see MAX_COORD and MAX_STITCHES).
pub fn stitch_shape(shape: &Shape, ls: &Map, jset: &Map) -> Res<Stitched> {
    if shape.pts.iter().any(|p| !(p.0.abs() <= MAX_COORD && p.1.abs() <= MAX_COORD)) {
        return Err(too_large());
    }
    let pts = path_of(shape);
    if pts.is_empty() {
        return Ok((vec![], String::new()));
    }
    let closed = shape.closed;
    if pts.len() == 1 {
        return Ok((vec![pts[0]], "p".into()));
    }
    if closed && get_b(jset, "points_on") {
        let (x0, y0, x1, y1) = geom::bbox([pts.as_slice()]);
        let size = if (y1 - y0) > (x1 - x0) { y1 - y0 } else { x1 - x0 };
        if size <= get_f(jset, "points_range", 50.0) + 1e-9 {
            // the machine program includes the limit
            return Ok((vec![((x0 + x1) / 2.0, (y0 + y1) / 2.0)], "p".into()));
        }
    }
    let mut st: Vec<(P, u8)>;
    if !get_bd(ls, "convert", true) {
        st = pts.iter().map(|&p| (p, b's')).collect();
    } else {
        let marks = &shape.marks;
        let corners = corner_distances(&pts, closed, get_f(ls, "corner_angle", 45.0));
        let (s0, cum) = base_stitches(&pts, ls, marks, &corners)?;
        st = s0;
        // corner index positions in the stitch list
        let mut cidx: Vec<i64> = vec![];
        for &c in &corners {
            let p = at(&pts, &cum, c);
            cidx.push(nearest_index(&st, p) as i64);
        }
        let n_int = st.len() as i64 - 1;
        let mut dense: HashSet<i64> = HashSet::new();
        if get_b(ls, "corner_dense") && !cidx.is_empty() {
            let k = get_i(ls, "corner_dense_n", 5);
            for &c in &cidx {
                // only the indexes inside the stitch list (a huge count would otherwise loop for ever)
                for i in c.saturating_sub(k).max(0)..c.saturating_add(k).min(n_int) {
                    dense.insert(i);
                }
            }
        }
        if get_b(ls, "se_dense") {
            let k = get_i(ls, "se_dense_n", 0);
            for i in 0..k.min(n_int) {
                dense.insert(i);
            }
            for i in 0.max(n_int.saturating_sub(k))..n_int {
                dense.insert(i);
            }
        }
        let factor = if get_b(ls, "corner_dense") {
            let f = get_f(ls, "corner_dense_f", 2.0);
            if f > 1.0 { f } else { 1.0 }
        } else {
            get_f(ls, "se_dense_f", 2.0)
        };
        st = densify(st, &dense, factor, b'd')?;
        if get_b(ls, "corner_slow") && !cidx.is_empty() {
            let k = get_i(ls, "corner_slow_n", 5);
            // recompute corner positions after densify
            let marks_pts: Vec<P> = corners.iter().map(|&c| at(&pts, &cum, c)).collect();
            for p in marks_pts {
                let ci = nearest_index(&st, p) as i64;
                let lo = 0.max(ci.saturating_sub(k));
                let hi = (st.len() as i64).min(ci.saturating_add(k).saturating_add(1));
                for i in lo..hi {
                    let i = i as usize;
                    if st[i].1 == b's' {
                        st[i].1 = b'w';
                    }
                }
            }
        }
        // zigzag and reverse-stitch sections
        for m in marks {
            let kind = mark_kind(m);
            if kind == "zigzag" {
                let zz = zigzag(&pts, &cum, m)?;
                let (ma, mb) = mark_ab(m);
                let (pa, pb) = (at(&pts, &cum, ma), at(&pts, &cum, mb));
                let ia = nearest_index(&st, pa);
                let ib = nearest_index(&st, pb);
                if ib > ia {
                    let mut ns = st[..ia].to_vec();
                    ns.extend(zz);
                    ns.extend_from_slice(&st[ib + 1..]);
                    st = ns;
                }
            } else if kind == "backtack" {
                let (ma, mb) = mark_ab(m);
                let (pa, pb) = (at(&pts, &cum, ma), at(&pts, &cum, mb));
                let ia = nearest_index(&st, pa);
                let ib = nearest_index(&st, pb);
                if ib > ia {
                    let sec: Vec<(P, u8)> = st[ia..=ib].iter().map(|&(p, _)| (p, b'b')).collect();
                    let mut ns = st[..=ib].to_vec();
                    ns.extend(sec[..sec.len() - 1].iter().rev().copied());
                    ns.extend_from_slice(&sec[1..]);
                    ns.extend_from_slice(&st[ib + 1..]);
                    st = ns;
                }
            }
        }
    }
    // back-tack / reinforcement at the ends
    let plain: Vec<P> = st.iter().map(|&(p, _)| p).collect();
    let (head, mut tail): (Vec<(P, u8)>, Vec<(P, u8)>);
    if closed {
        let (ks, rs) = (get_i(ls, "cl_start", 0), get_i(ls, "cl_start_rep", 1));
        let (ke, re) = (get_i(ls, "cl_end", 0), get_i(ls, "cl_end_rep", 1));
        head = if ks > 0 { tack(&plain, ks, rs, b'r')? } else { vec![] };
        tail = vec![];
        if ke > 0 {
            let (a, b) = sl(plain.len(), 1, ke.saturating_add(1));
            let lp = &plain[a..b]; // overlap past the start point
            let (c, d) = sl(plain.len(), 0, ke);
            let back: Vec<P> = plain[c..d].iter().rev().copied().collect();
            budget(1.max(re) as f64 * lp.len().max(back.len()) as f64)?;
            for r in 0..1.max(re) {
                if r % 2 == 0 {
                    tail.extend(lp.iter().map(|&p| (p, b'r')));
                } else {
                    tail.extend(back.iter().map(|&p| (p, b'r')));
                }
            }
        }
        let rep = get_i(ls, "end_repeat", 0);
        if rep > 0 {
            let (a, b) = sl(plain.len(), 1, rep.saturating_add(1));
            tail.extend(plain[a..b].iter().map(|&p| (p, b'r')));
        }
    } else {
        let (ks, rs) = (get_i(ls, "bt_start", 0), get_i(ls, "bt_start_rep", 0));
        let (ke, re) = (get_i(ls, "bt_end", 0), get_i(ls, "bt_end_rep", 0));
        head = if ks > 0 { tack(&plain, ks, rs, b'b')? } else { vec![] };
        let rev: Vec<P> = plain.iter().rev().copied().collect();
        tail = if ke > 0 { tack(&rev, ke, re, b'b')? } else { vec![] };
    }
    budget((st.len() + head.len() + tail.len()) as f64)?;
    let mut res = Vec::with_capacity(st.len() + head.len() + tail.len());
    res.push(st[0]);
    res.extend(head);
    res.extend_from_slice(&st[1..]);
    res.append(&mut tail);
    let flags: String = res.iter().map(|&(_, f)| f as char).collect();
    Ok((res.into_iter().map(|(p, _)| p).collect(), flags))
}

/// Everything a shape's stitches depend on; equal keys give equal stitches.
pub fn shape_key(s: &Shape, ls: &Map, j: &Map) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    for p in &s.pts {
        p.0.to_bits().hash(&mut h);
        p.1.to_bits().hash(&mut h);
    }
    s.closed.hash(&mut h);
    serde_json::to_string(&s.marks).unwrap_or_default().hash(&mut h);
    let sorted: BTreeSet<(String, String)> = ls.iter().map(|(k, v)| (k.clone(), v.to_string())).collect();
    for kv in sorted {
        kv.hash(&mut h);
    }
    crate::model::get_b(j, "points_on").hash(&mut h);
    j.get("points_range").map(|v| v.to_string()).unwrap_or_default().hash(&mut h);
    h.finish()
}

/// {shape id: (points, flags)} for every shape. `cache` ({id: (key, result)}) skips unchanged shapes and is
/// left as it was when the job is too large to stitch.
pub fn stitch_job(job: &Job, cache: Option<&mut HashMap<i64, (u64, Stitched)>>) -> Res<StitchMap> {
    let j = &job.settings;
    let layers: HashMap<&str, &Map> = job.layers.iter().map(|l| (l.id.as_str(), &l.settings)).collect();
    let empty = Map::new();
    let mut out = StitchMap::new();
    let mut total = 0usize;
    match cache {
        None => {
            for s in &job.shapes {
                let ls = layers.get(s.layer.as_str()).copied().unwrap_or(&empty);
                let res = stitch_shape(s, ls, j)?;
                total += res.0.len();
                budget(total as f64)?;
                out.insert(s.id, res);
            }
        }
        Some(cache) => {
            let mut fresh: HashMap<i64, (u64, Stitched)> = HashMap::new();
            for s in &job.shapes {
                let ls = layers.get(s.layer.as_str()).copied().unwrap_or(&empty);
                let k = shape_key(s, ls, j);
                let res = match cache.get(&s.id) {
                    Some((hk, r)) if *hk == k => r.clone(),
                    _ => stitch_shape(s, ls, j)?,
                };
                total += res.0.len();
                budget(total as f64)?;
                fresh.insert(s.id, (k, res.clone()));
                out.insert(s.id, res);
            }
            *cache = fresh;
        }
    }
    Ok(out)
}

pub fn value_is_null(v: Option<&Value>) -> bool {
    matches!(v, None | Some(Value::Null))
}
