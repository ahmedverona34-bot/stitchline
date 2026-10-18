//! Basic 2D geometry helpers. All coordinates are millimetres, y axis up. (port of engine/geom.py)
use crate::py;

pub type P = (f64, f64);
pub const EPS: f64 = 1e-9;

pub fn dist(a: P, b: P) -> f64 {
    py::hypot(b.0 - a.0, b.1 - a.1)
}

pub fn path_length(pts: &[P]) -> f64 {
    py::fsum((1..pts.len()).map(|i| dist(pts[i - 1], pts[i])))
}

/// (x0, y0, x1, y1) over every point of every path
pub fn bbox<'a, I: IntoIterator<Item = &'a [P]>>(pts_list: I) -> (f64, f64, f64, f64) {
    let lists: Vec<&[P]> = pts_list.into_iter().collect();
    let xs = lists.iter().flat_map(|l| l.iter().map(|p| p.0));
    let ys = lists.iter().flat_map(|l| l.iter().map(|p| p.1));
    match (py::fmin(xs.clone()), py::fmin(ys.clone()), py::fmax(xs), py::fmax(ys)) {
        (Some(a), Some(b), Some(c), Some(d)) => (a, b, c, d),
        _ => (0.0, 0.0, 0.0, 0.0),
    }
}

/// Points of a counter-clockwise arc from angle a0 to a1 (degrees).
pub fn arc_points(cx: f64, cy: f64, r: f64, a0: f64, a1: f64) -> Vec<P> {
    let step_deg = 4.0;
    if (a1 - a0).abs() < 1e-12 {
        return vec![(cx + r * py::cos(py::radians(a0)), cy + r * py::sin(py::radians(a0)))];
    }
    let mut a1 = a1;
    while a1 <= a0 {
        a1 += 360.0;
    }
    let sweep = a1 - a0;
    let n = std::cmp::max(2, (sweep / step_deg) as i64 + 1);
    (0..=n)
        .map(|i| {
            let a = a0 + sweep * i as f64 / n as f64;
            (cx + r * py::cos(py::radians(a)), cy + r * py::sin(py::radians(a)))
        })
        .collect()
}

/// Points from p0 to p1 along a DXF polyline bulge arc (excluding p0, including p1).
pub fn bulge_points(p0: P, p1: P, bulge: f64) -> Vec<P> {
    let step_deg = 4.0;
    if bulge.abs() < 1e-12 {
        return vec![p1];
    }
    let theta = 4.0 * py::atan(bulge);
    let chord = dist(p0, p1);
    if chord < EPS {
        return vec![p1];
    }
    let r = chord / (2.0 * py::sin(theta / 2.0));
    let alpha = py::atan2(p1.1 - p0.1, p1.0 - p0.0);
    let cx = p0.0 + r * py::cos(alpha + py::PI / 2.0 - theta / 2.0);
    let cy = p0.1 + r * py::sin(alpha + py::PI / 2.0 - theta / 2.0);
    let rad = r.abs();
    let a0 = py::atan2(p0.1 - cy, p0.0 - cx);
    let n = std::cmp::max(1, (py::degrees(theta.abs()) / step_deg).ceil() as i64);
    let mut out: Vec<P> = (1..=n)
        .map(|i| {
            let a = a0 + theta * i as f64 / n as f64;
            (cx + rad * py::cos(a), cy + rad * py::sin(a))
        })
        .collect();
    let last = out.len() - 1;
    out[last] = p1;
    out
}

#[allow(clippy::too_many_arguments)]
pub fn ellipse_points(cx: f64, cy: f64, mx: f64, my: f64, ratio: f64, t0: f64, t1: f64) -> Vec<P> {
    let step_deg = 4.0;
    let mut t1 = t1;
    while t1 <= t0 {
        t1 += 2.0 * py::PI;
    }
    let major = py::hypot(mx, my);
    let rot = py::atan2(my, mx);
    let minor = major * ratio;
    let n = std::cmp::max(4, (py::degrees(t1 - t0) / step_deg).ceil() as i64);
    (0..=n)
        .map(|i| {
            let t = t0 + (t1 - t0) * i as f64 / n as f64;
            let (x, y) = (major * py::cos(t), minor * py::sin(t));
            (cx + x * py::cos(rot) - y * py::sin(rot), cy + x * py::sin(rot) + y * py::cos(rot))
        })
        .collect()
}

/// Evaluate a (non-rational) B-spline with de Boor's algorithm.
pub fn bspline_points(ctrl: &[P], degree: i64, knots: &[f64]) -> Vec<P> {
    let samples_per_span: i64 = 12;
    let n = ctrl.len() as i64;
    if n < 2 {
        return ctrl.to_vec();
    }
    let p = std::cmp::min(degree, n - 1);
    let knots: Vec<f64> = if knots.is_empty() || knots.len() as i64 != n + p + 1 {
        let mut k = vec![0.0; (p + 1).max(0) as usize];
        for i in 1..(n - p) {
            k.push(i as f64 / (n - p) as f64);
        }
        k.extend(std::iter::repeat(1.0).take((p + 1).max(0) as usize));
        k
    } else {
        knots.to_vec()
    };
    let kn = |i: i64| -> f64 { knots[py_index(i, knots.len())] };
    let (t_start, t_end) = (kn(p), kn(n));
    let total = std::cmp::max(2, samples_per_span * (n - p));
    let mut out = Vec::with_capacity(total as usize + 1);
    for s in 0..=total {
        let t = t_start + (t_end - t_start) * s as f64 / total as f64;
        let mut k = p;
        while k < n - 1 && kn(k + 1) <= t {
            k += 1;
        }
        let mut d: Vec<[f64; 2]> = (0..=p).map(|j| {
            let c = ctrl[py_index(j + k - p, ctrl.len())];
            [c.0, c.1]
        }).collect();
        for r in 1..=p {
            let mut j = p;
            while j > r - 1 {
                let i = j + k - p;
                let den = kn(i + p - r + 1) - kn(i);
                let a = if den == 0.0 { 0.0 } else { (t - kn(i)) / den };
                let (ju, jm) = (j as usize, (j - 1) as usize);
                d[ju] = [(1.0 - a) * d[jm][0] + a * d[ju][0], (1.0 - a) * d[jm][1] + a * d[ju][1]];
                j -= 1;
            }
        }
        let last = d[p as usize];
        out.push((last[0], last[1]));
    }
    out
}

/// Python list index (negative counts from the end).
fn py_index(i: i64, len: usize) -> usize {
    if i < 0 { (len as i64 + i) as usize } else { i as usize }
}

pub fn rotate_pts(pts: &[P], ang_deg: f64, cx: f64, cy: f64) -> Vec<P> {
    let a = py::radians(ang_deg);
    let (c, s) = (py::cos(a), py::sin(a));
    pts.iter().map(|&(x, y)| (cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c)).collect()
}

/// Direction change in degrees at point b (0 = straight on).
pub fn turn_angle(a: P, b: P, c: P) -> f64 {
    let v1 = (b.0 - a.0, b.1 - a.1);
    let v2 = (c.0 - b.0, c.1 - b.1);
    let (l1, l2) = (py::hypot(v1.0, v1.1), py::hypot(v2.0, v2.1));
    if l1 < EPS || l2 < EPS {
        return 0.0;
    }
    let cosv = (-1.0f64).max(((v1.0 * v2.0 + v1.1 * v2.1) / (l1 * l2)).min(1.0));
    py::degrees(py::acos(cosv))
}

/// Point at distance d along the path, and the index of the segment end.
pub fn point_on_path(pts: &[P], d: f64) -> (P, usize) {
    let mut acc = 0.0;
    for i in 1..pts.len() {
        let seg = dist(pts[i - 1], pts[i]);
        if acc + seg >= d && seg > EPS {
            let t = (d - acc) / seg;
            return ((pts[i - 1].0 + (pts[i].0 - pts[i - 1].0) * t, pts[i - 1].1 + (pts[i].1 - pts[i - 1].1) * t), i);
        }
        acc += seg;
    }
    (pts[pts.len() - 1], pts.len() - 1)
}

/// (distance along path, distance to q) of the closest point on the path to q.
pub fn nearest_on_path(pts: &[P], q: P) -> (f64, f64) {
    let mut best = (0.0, f64::INFINITY);
    let mut acc = 0.0;
    for i in 1..pts.len() {
        let (a, b) = (pts[i - 1], pts[i]);
        let seg = dist(a, b);
        if seg < EPS {
            continue;
        }
        let t = 0.0f64.max((((q.0 - a.0) * (b.0 - a.0) + (q.1 - a.1) * (b.1 - a.1)) / (seg * seg)).min(1.0));
        let p = (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t);
        let dq = dist(p, q);
        if dq < best.1 {
            best = (acc + seg * t, dq);
        }
        acc += seg;
    }
    best
}
