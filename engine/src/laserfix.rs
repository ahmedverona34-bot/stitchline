//! Laser speed: find and fix what makes a laser layer cut slowly. (port of engine/laserfix.py)
//!
//! The machine slows down at every point of a path, and every separate laser cut runs the laser start and stop
//! sequence (output IO, delays, Z axis). So a layer cuts slowly when its curves are made of many tiny segments
//! (typical for PLT files from drawing programs) or when it is split into many separate lines.
//! The fix keeps the cut within `tol` mm of the drawing.
use crate::error::{Error, Res};
use crate::geom::{self, P};
use crate::model::Job;
use crate::ops;
use crate::py;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

const TINY: f64 = 0.5; // mm: segments shorter than this make the machine crawl

fn path(s: &crate::model::Shape) -> Vec<P> {
    let mut p = s.pts.clone();
    if s.closed && p.len() > 2 {
        p.push(p[0]);
    }
    p
}

/// Numbers that explain the cutting speed of one layer.
pub fn check(job: &Job, lid: &str) -> Value {
    let shapes: Vec<&crate::model::Shape> = job.shapes.iter().filter(|s| s.layer == lid).collect();
    let mut seg = vec![];
    for s in &shapes {
        let p = path(s);
        for w in p.windows(2) {
            seg.push(geom::dist(w[0], w[1]));
        }
    }
    let mut ends: Vec<P> = vec![];
    for s in &shapes {
        if !s.closed && s.pts.len() > 1 {
            ends.push(s.pts[0]);
            ends.push(s.pts[s.pts.len() - 1]);
        }
    }
    // ends within 0.1 mm of an end of another shape (a grid instead of comparing every pair)
    let cell = 0.10001;
    let key = |p: P| ((p.0 / cell).floor() as i64, (p.1 / cell).floor() as i64);
    let mut grid: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
    for (j, &b) in ends.iter().enumerate() {
        grid.entry(key(b)).or_default().push(j);
    }
    let mut touching = 0;
    for (i, &a) in ends.iter().enumerate() {
        let (cx, cy) = key(a);
        let mut hit = false;
        'cells: for gx in cx - 1..=cx + 1 {
            for gy in cy - 1..=cy + 1 {
                if let Some(v) = grid.get(&(gx, gy)) {
                    for &j in v {
                        if j != i && j / 2 != i / 2 && geom::dist(a, ends[j]) <= 0.1 {
                            hit = true;
                            break 'cells;
                        }
                    }
                }
            }
        }
        if hit {
            touching += 1;
        }
    }
    let shortest = py::fmin(seg.iter().copied()).unwrap_or(0.0);
    json!({
        "shapes": shapes.len(),
        "points": shapes.iter().map(|s| s.pts.len()).sum::<usize>(),
        "segments": seg.len(),
        "tiny": seg.iter().filter(|&&d| d < TINY).count(),
        "shortest": shortest,
        "length": py::fsum(seg.iter().copied()),
        "joinable": touching / 2,
    })
}

/// Douglas-Peucker: drop points that stay within tol mm of the line through their neighbours.
fn simplify(pts: &[P], tol: f64) -> Vec<P> {
    if pts.len() < 3 {
        return pts.to_vec();
    }
    let mut keep = vec![false; pts.len()];
    keep[0] = true;
    let last = pts.len() - 1;
    keep[last] = true;
    let mut stack = vec![(0usize, last)];
    while let Some((a, b)) = stack.pop() {
        let (pa, pb) = (pts[a], pts[b]);
        let (dx, dy) = (pb.0 - pa.0, pb.1 - pa.1);
        let l = py::pow(dx * dx + dy * dy, 0.5);
        let (mut best, mut bi) = (-1.0f64, 0usize);
        for (i, &(px, py_)) in pts.iter().enumerate().take(b).skip(a + 1) {
            let d = if l < 1e-12 {
                geom::dist(pa, pts[i])
            } else {
                let t = 0.0f64.max((((px - pa.0) * dx + (py_ - pa.1) * dy) / (l * l)).min(1.0));
                geom::dist((pa.0 + dx * t, pa.1 + dy * t), (px, py_))
            };
            if d > best {
                best = d;
                bi = i;
            }
        }
        if best > tol {
            keep[bi] = true;
            stack.push((a, bi));
            stack.push((bi, b));
        }
    }
    pts.iter().zip(keep).filter(|(_, k)| *k).map(|(p, _)| *p).collect()
}

/// A set of shape ids that iterates in the same order as a CPython 3.12 set of small ints
/// (min() over a set picks the first of equal distances in that order).
struct PySet {
    table: Vec<Option<i64>>, // Some(-1) never used for ids; a removed entry is marked with DUMMY
    fill: usize,
    used: usize,
}

const DUMMY: i64 = i64::MIN;

impl PySet {
    fn from_list(items: &[i64]) -> PySet {
        let mut s = PySet { table: vec![None; 8], fill: 0, used: 0 };
        for &i in items {
            s.add(i);
        }
        s
    }

    fn hash(v: i64) -> u64 {
        // hash() of a non-negative int below 2**61 - 1 is the int itself; -1 hashes to -2
        if v == -1 { (-2i64) as u64 } else { v as u64 }
    }

    fn add(&mut self, key: i64) {
        let mask = self.table.len() - 1;
        let h = Self::hash(key);
        let mut i = (h as usize) & mask;
        let mut perturb = h;
        let mut freeslot: Option<usize> = None;
        loop {
            let probes = if i + 9 <= mask { 9 } else { 0 };
            let mut j = i;
            for _ in 0..=probes {
                match self.table[j] {
                    None => {
                        let slot = freeslot.unwrap_or(j);
                        if freeslot.is_some() {
                            self.table[slot] = Some(key);
                            self.used += 1;
                            return;
                        }
                        self.table[slot] = Some(key);
                        self.fill += 1;
                        self.used += 1;
                        if self.fill * 5 >= mask * 3 {
                            self.resize(if self.used > 50000 { self.used * 2 } else { self.used * 4 });
                        }
                        return;
                    }
                    Some(DUMMY) => {
                        if freeslot.is_none() {
                            freeslot = Some(j);
                        }
                    }
                    Some(k) if k == key => return,
                    _ => {}
                }
                j += 1;
            }
            perturb >>= 5;
            i = ((i as u64).wrapping_mul(5).wrapping_add(1).wrapping_add(perturb) as usize) & mask;
        }
    }

    fn resize(&mut self, minused: usize) {
        let mut newsize = 8;
        while newsize <= minused {
            newsize <<= 1;
        }
        let old = std::mem::replace(&mut self.table, vec![None; newsize]);
        self.fill = 0;
        self.used = 0;
        let mask = newsize - 1;
        for k in old.into_iter().flatten() {
            if k == DUMMY {
                continue;
            }
            let h = Self::hash(k);
            let mut i = (h as usize) & mask;
            let mut perturb = h;
            'find: loop {
                if self.table[i].is_none() {
                    break 'find;
                }
                if i + 9 <= mask {
                    let mut found = None;
                    for j in 1..=9 {
                        if self.table[i + j].is_none() {
                            found = Some(i + j);
                            break;
                        }
                    }
                    if let Some(f) = found {
                        i = f;
                        break 'find;
                    }
                }
                perturb >>= 5;
                i = ((i as u64).wrapping_mul(5).wrapping_add(1).wrapping_add(perturb) as usize) & mask;
            }
            self.table[i] = Some(k);
            self.fill += 1;
            self.used += 1;
        }
    }

    fn discard(&mut self, key: i64) {
        for slot in self.table.iter_mut() {
            if *slot == Some(key) {
                *slot = Some(DUMMY);
                self.used -= 1;
                return;
            }
        }
    }

    fn iter(&self) -> impl Iterator<Item = i64> + '_ {
        self.table.iter().filter_map(|s| match s {
            Some(k) if *k != DUMMY => Some(*k),
            _ => None,
        })
    }

    fn is_empty(&self) -> bool {
        self.used == 0
    }
}

/// Speed up one layer: join touching lines, drop needless points, cut in the shortest order. Returns (before, after).
pub fn fix(job: &mut Job, lid: &str, tol: f64) -> Res<(Value, Value)> {
    let join_tol = 0.1;
    let before = check(job, lid);
    let ids: Vec<i64> = job.shapes.iter().filter(|s| s.layer == lid).map(|s| s.id).collect();
    if ids.is_empty() {
        return Err(Error::op("This layer has no shapes."));
    }
    // 1. one continuous cut where lines meet
    ops::join_lines(job, &ids, join_tol, true)?;
    // 2. remove repeated points and points that do not change the path
    for s in job.shapes.iter_mut() {
        if s.layer != lid || s.pts.len() < 3 {
            continue;
        }
        let mut p = vec![s.pts[0]];
        for &q in &s.pts[1..] {
            if geom::dist(p[p.len() - 1], q) > 0.01 {
                p.push(q);
            }
        }
        if s.closed {
            // simplify the ring from its start point; keep at least a triangle
            let mut ring = p.clone();
            ring.push(p[0]);
            let ring = simplify(&ring, tol);
            if ring.len() > 3 {
                p = ring[..ring.len() - 1].to_vec();
            }
        } else {
            p = simplify(&p, tol);
        }
        s.pts = p;
        s.marks.clear();
    }
    // 3. shortest travel between the cuts of this layer, keeping the other layers where they are
    let idx = job.shape_index();
    let shape = |sid: i64| -> Res<&crate::model::Shape> { idx.get(&sid).map(|&i| &job.shapes[i]).ok_or(Error::Missing) };
    let mut lay = vec![];
    for &sid in &job.order {
        if shape(sid)?.layer == lid {
            lay.push(sid);
        }
    }
    if !lay.is_empty() {
        let first = shape(lay[0])?;
        let mut pos = *first.pts.first().ok_or_else(|| Error::Unexpected("list index out of range".into()))?;
        let mut left = PySet::from_list(&lay);
        let mut route = vec![];
        while !left.is_empty() {
            let mut best: Option<(i64, f64)> = None;
            for i in left.iter() {
                let d = geom::dist(pos, shape(i)?.pts[0]);
                if best.map(|b| d < b.1).unwrap_or(true) {
                    best = Some((i, d));
                }
            }
            let nxt = best.unwrap().0;
            route.push(nxt);
            left.discard(nxt);
            let sh = shape(nxt)?;
            pos = if sh.closed { sh.pts[0] } else { sh.pts[sh.pts.len() - 1] };
        }
        let mut slots = route.into_iter();
        let lays: HashSet<i64> = lay.iter().copied().collect();
        let order: Vec<i64> = job.order.iter().map(|&sid| if lays.contains(&sid) { slots.next().unwrap_or(sid) } else { sid }).collect();
        job.order = order;
    }
    let after = check(job, lid);
    Ok((before, after))
}

#[cfg(test)]
mod tests {
    use super::PySet;
    #[test]
    fn set_order_like_cpython() {
        // list(set([...])) in CPython 3.12
        let s = PySet::from_list(&[9, 1, 17, 33, 2, 100, 8, 16]);
        assert_eq!(s.iter().collect::<Vec<_>>(), vec![33, 2, 1, 100, 8, 9, 16, 17]);
        let mut s = PySet::from_list(&[5, 13, 21, 29, 37, 45, 53, 61, 69, 77, 85, 93, 101, 109]);
        s.discard(21);
        assert_eq!(s.iter().collect::<Vec<_>>(), vec![37, 5, 69, 101, 13, 45, 77, 109, 61, 93, 53, 85, 29]);
        let v: Vec<i64> = (1000..1060).step_by(3).collect();
        let s = PySet::from_list(&v);
        let mut want: Vec<i64> = (1024..1060).step_by(3).collect();
        want.extend((1000..1024).step_by(3));
        assert_eq!(s.iter().collect::<Vec<_>>(), want);
    }
}
