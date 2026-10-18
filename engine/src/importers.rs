//! Drawing importers: DXF, HPGL/PLT, Tajima DST, Barudan DSB, Illustrator AI and SLW. (port of engine/importers.py)
//!
//! Each importer returns a list of raw paths (layer, points in millimetres, closed).
use crate::error::{Error, Res};
use crate::geom::{self, P};
use crate::py;
use regex::bytes::Regex;
use std::collections::HashMap;
use std::sync::OnceLock;

#[derive(Clone, Debug)]
pub struct RawPath {
    pub layer: String,
    pub pts: Vec<P>,
    pub closed: bool,
}

fn insunits_mm(u: i64) -> Option<f64> {
    Some(match u {
        0 => 1.0,
        1 => 25.4,
        2 => 304.8,
        4 => 1.0,
        5 => 10.0,
        6 => 1000.0,
        8 => 0.0000254,
        9 => 0.0254,
        10 => 914.4,
        _ => return None,
    })
}

fn not_float(v: &str) -> Error {
    Error::Op(format!("could not convert string to float: {}", py::py_repr(&serde_json::Value::String(v.to_string()))))
}

/// The file as text: UTF-8 when it is, otherwise one character per byte (ASCII stays ASCII).
pub fn read_text(raw: &[u8]) -> String {
    match std::str::from_utf8(raw) {
        Ok(s) => s.to_string(),
        Err(_) => raw.iter().map(|&b| if b < 0x80 { b as char } else { char::from_u32(0x100 + b as u32).unwrap() }).collect(),
    }
}

// ------------------------------------------------------------------------------------------- DXF

fn pairs(text: &str) -> Vec<(i64, String)> {
    let lines = py::splitlines(text);
    let mut out = vec![];
    let mut i = 0;
    while i + 1 < lines.len() {
        if let Some(code) = py::parse_int(lines[i]) {
            out.push((code, py::strip(lines[i + 1]).to_string()));
        }
        i += 2;
    }
    out
}

#[derive(Clone, Debug)]
struct Ent {
    typ: String,
    g: Vec<(i64, String)>,
    // folded old-style POLYLINE
    layer: String,
    closed: bool,
    verts: Vec<[f64; 3]>,
}

impl Ent {
    fn new(typ: &str) -> Ent {
        Ent { typ: typ.into(), g: vec![], layer: String::new(), closed: false, verts: vec![] }
    }
    fn get_f(&self, code: i64, d: f64) -> f64 {
        match self.g.iter().find(|(c, _)| *c == code) {
            None => d,
            Some((_, v)) => py::parse_float(v).unwrap_or(d),
        }
    }
    fn get_i(&self, code: i64, d: i64) -> i64 {
        match self.g.iter().find(|(c, _)| *c == code) {
            None => d,
            Some((_, v)) => py::parse_int(v).unwrap_or(d),
        }
    }
    fn get_s(&self, code: i64, d: &str) -> String {
        match self.g.iter().find(|(c, _)| *c == code) {
            None => d.to_string(),
            Some((_, v)) => v.clone(),
        }
    }
    fn all_f(&self, code: i64) -> Vec<f64> {
        self.g.iter().filter(|(c, _)| *c == code).filter_map(|(_, v)| py::parse_float(v)).collect()
    }
}

struct Block {
    base: [f64; 2],
    ents: Vec<Ent>,
}

const NONE_SEC: &str = "\u{0}None";

type Sections = HashMap<String, Vec<Ent>>;

/// Group (code, value) pairs into entities per section, and blocks.
fn entities(pairs: Vec<(i64, String)>) -> Res<(Sections, Vec<(String, Block)>)> {
    let mut sections: Sections = HashMap::new();
    let mut cur_sec: String = NONE_SEC.into();
    let mut cur: Option<Ent> = None;
    let mut block: Option<String> = None;
    let mut blocks: Vec<(String, Block)> = vec![];
    let find = |blocks: &Vec<(String, Block)>, name: &str| blocks.iter().position(|(n, _)| n == name);
    for (code, val) in pairs {
        if code == 0 {
            if let Some(c) = cur.take() {
                match (&block, cur_sec == "BLOCKS") {
                    (Some(b), true) if !b.is_empty() => {
                        let i = find(&blocks, b).ok_or(Error::Missing)?;
                        blocks[i].1.ents.push(c);
                    }
                    _ => sections.entry(cur_sec.clone()).or_default().push(c),
                }
            }
            if val == "SECTION" {
                cur_sec = "pending".into();
                continue;
            }
            if val == "ENDSEC" {
                cur_sec = NONE_SEC.into();
                continue;
            }
            if val == "EOF" {
                break;
            }
            if cur_sec == "BLOCKS" && val == "BLOCK" {
                block = Some("__new__".into());
                cur = Some(Ent::new("BLOCK"));
                continue;
            }
            if cur_sec == "BLOCKS" && val == "ENDBLK" {
                block = None;
                continue;
            }
            cur = Some(Ent::new(&val));
            continue;
        }
        if cur_sec == "pending" && code == 2 {
            cur_sec = val;
            continue;
        }
        if let Some(c) = cur.as_mut() {
            if c.typ == "BLOCK" && code == 2 {
                block = Some(val.clone());
                let nb = Block { base: [0.0, 0.0], ents: vec![] };
                match find(&blocks, &val) {
                    Some(i) => blocks[i].1 = nb,
                    None => blocks.push((val.clone(), nb)),
                }
            }
            if c.typ == "BLOCK" && (code == 10 || code == 20) {
                if let Some(i) = block.as_deref().and_then(|b| find(&blocks, b)) {
                    let f = py::parse_float(&val).ok_or_else(|| not_float(&val))?;
                    blocks[i].1.base[if code == 10 { 0 } else { 1 }] = f;
                }
            }
            c.g.push((code, val));
        }
    }
    if let Some(c) = cur {
        if c.typ != "BLOCK" {
            sections.entry(cur_sec).or_default().push(c);
        }
    }
    for (_, b) in blocks.iter_mut() {
        b.ents.retain(|e| e.typ != "BLOCK");
    }
    Ok((sections, blocks))
}

fn header_units(sections: &Sections) -> i64 {
    // header variables come as one long group list under the first pseudo-entity; scan them all
    if let Some(hdr) = sections.get("HEADER") {
        for e in hdr {
            let g = &e.g;
            for (i, (c, v)) in g.iter().enumerate() {
                if *c == 9 && v == "$INSUNITS" && i + 1 < g.len() {
                    return py::parse_int(&g[i + 1].1).unwrap_or(0);
                }
            }
        }
    }
    0
}

type Xf<'a> = &'a dyn Fn(f64, f64) -> P;

fn poly_from_verts(layer: &str, verts: &[[f64; 3]], closed: bool, xf: Xf) -> RawPath {
    if verts.is_empty() {
        return RawPath { layer: layer.into(), pts: vec![], closed: false };
    }
    let mut pts: Vec<P> = vec![(verts[0][0], verts[0][1])];
    let n = verts.len();
    for i in 1..(n + if closed { 1 } else { 0 }) {
        let a = verts[i - 1];
        let b = verts[i % n];
        pts.extend(geom::bulge_points((a[0], a[1]), (b[0], b[1]), a[2]));
    }
    RawPath { layer: layer.into(), pts: pts.into_iter().map(|p| xf(p.0, p.1)).collect(), closed }
}

/// Append paths of entity e (transformed by xf) to out.
fn entity_paths(e: &Ent, out: &mut Vec<RawPath>, blocks: &[(String, Block)], xf: Xf, depth: usize) -> Res<()> {
    let layer = e.get_s(8, "0");
    let t = e.typ.as_str();
    match t {
        "LINE" => {
            let a = xf(e.get_f(10, 0.0), e.get_f(20, 0.0));
            let b = xf(e.get_f(11, 0.0), e.get_f(21, 0.0));
            out.push(RawPath { layer, pts: vec![a, b], closed: false });
        }
        "POINT" => {
            let p = xf(e.get_f(10, 0.0), e.get_f(20, 0.0));
            out.push(RawPath { layer, pts: vec![p], closed: false });
        }
        "CIRCLE" => {
            let (cx, cy, r) = (e.get_f(10, 0.0), e.get_f(20, 0.0), e.get_f(40, 0.0));
            let pts = geom::arc_points(cx, cy, r, 45.0, 405.0); // the machine program starts circles at 45 degrees
            out.push(RawPath { layer, pts: pts.into_iter().map(|p| xf(p.0, p.1)).collect(), closed: true });
        }
        "ARC" => {
            let (cx, cy, r) = (e.get_f(10, 0.0), e.get_f(20, 0.0), e.get_f(40, 0.0));
            let pts = geom::arc_points(cx, cy, r, e.get_f(50, 0.0), e.get_f(51, 360.0));
            out.push(RawPath { layer, pts: pts.into_iter().map(|p| xf(p.0, p.1)).collect(), closed: false });
        }
        "ELLIPSE" => {
            let tau = 2.0 * py::PI;
            let pts = geom::ellipse_points(
                e.get_f(10, 0.0), e.get_f(20, 0.0), e.get_f(11, 1.0), e.get_f(21, 0.0), e.get_f(40, 1.0), e.get_f(41, 0.0), e.get_f(42, tau),
            );
            let closed = ((e.get_f(42, tau) - e.get_f(41, 0.0)) - tau).abs() < 1e-6;
            out.push(RawPath { layer, pts: pts.into_iter().map(|p| xf(p.0, p.1)).collect(), closed });
        }
        "LWPOLYLINE" => {
            let flags = e.get_i(70, 0);
            let mut verts: Vec<[f64; 3]> = vec![];
            for (c, v) in &e.g {
                if *c == 10 {
                    verts.push([py::parse_float(v).ok_or_else(|| not_float(v))?, 0.0, 0.0]);
                } else if *c == 20 && !verts.is_empty() {
                    let n = verts.len();
                    verts[n - 1][1] = py::parse_float(v).ok_or_else(|| not_float(v))?;
                } else if *c == 42 && !verts.is_empty() {
                    let n = verts.len();
                    verts[n - 1][2] = py::parse_float(v).ok_or_else(|| not_float(v))?;
                }
            }
            out.push(poly_from_verts(&layer, &verts, flags & 1 != 0, xf));
        }
        "SPLINE" => {
            let deg = e.get_i(71, 3);
            let knots = e.all_f(40);
            let ctrl: Vec<P> = e.all_f(10).into_iter().zip(e.all_f(20)).collect();
            let fit: Vec<P> = e.all_f(11).into_iter().zip(e.all_f(21)).collect();
            let pts = if ctrl.len() >= 2 { geom::bspline_points(&ctrl, deg, &knots) } else { fit };
            if !pts.is_empty() {
                out.push(RawPath { layer, pts: pts.into_iter().map(|p| xf(p.0, p.1)).collect(), closed: e.get_i(70, 0) & 1 != 0 });
            }
        }
        "INSERT" if depth < 8 => {
            let name = e.get_s(2, "");
            let Some((_, b)) = blocks.iter().find(|(n, _)| *n == name) else { return Ok(()) };
            let (ix, iy) = (e.get_f(10, 0.0), e.get_f(20, 0.0));
            let (sx, sy) = (e.get_f(41, 1.0), e.get_f(42, 1.0));
            let rot = py::radians(e.get_f(50, 0.0));
            let (bx, by) = (b.base[0], b.base[1]);
            let (c, s) = (py::cos(rot), py::sin(rot));
            let xf2 = move |x: f64, y: f64| -> P {
                let (x, y) = ((x - bx) * sx, (y - by) * sy);
                xf(ix + x * c - y * s, iy + x * s + y * c)
            };
            for sub in &b.ents {
                entity_paths(sub, out, blocks, &xf2, depth + 1)?;
                if let Some(last) = out.last_mut() {
                    if last.layer == "0" {
                        last.layer = layer.clone();
                    }
                }
            }
        }
        _ => {}
    }
    Ok(())
}

/// Fold POLYLINE / VERTEX / SEQEND sequences into pseudo-entities.
fn old_polylines(ents: Vec<Ent>) -> Vec<Ent> {
    let mut out = vec![];
    let mut cur: Option<Ent> = None;
    for e in ents {
        let t = e.typ.as_str();
        if t == "POLYLINE" {
            let mut p = Ent::new("_POLY");
            p.layer = e.get_s(8, "0");
            p.closed = e.get_i(70, 0) & 1 != 0;
            cur = Some(p);
        } else if t == "VERTEX" && cur.is_some() {
            if e.get_i(70, 0) & 16 != 0 {
                // spline frame control point
                continue;
            }
            cur.as_mut().unwrap().verts.push([e.get_f(10, 0.0), e.get_f(20, 0.0), e.get_f(42, 0.0)]);
        } else if t == "SEQEND" && cur.is_some() {
            out.push(cur.take().unwrap());
        } else {
            out.push(e);
        }
    }
    out
}

pub fn read_dxf(raw: &[u8]) -> Res<Vec<RawPath>> {
    let (mut sections, blocks) = entities(pairs(&read_text(raw)))?;
    let unit = insunits_mm(header_units(&sections)).unwrap_or(1.0);
    let unit = if unit == 0.0 { 1.0 } else { unit };
    let xf = move |x: f64, y: f64| -> P { (x * unit, y * unit) };
    let mut out = vec![];
    for e in old_polylines(sections.remove("ENTITIES").unwrap_or_default()) {
        if e.typ == "_POLY" {
            out.push(poly_from_verts(&e.layer, &e.verts, e.closed, &xf));
        } else {
            entity_paths(&e, &mut out, &blocks, &xf, 0)?;
        }
    }
    for p in out.iter_mut() {
        // the machine program puts a whole DXF into one layer
        p.layer = "Layer1".into();
    }
    Ok(out.into_iter().filter(|p| !p.pts.is_empty()).collect())
}

// ------------------------------------------------------------------------------------------- HPGL / PLT

pub fn read_plt(raw: &[u8], dpi: f64) -> Vec<RawPath> {
    let text = read_text(raw).replace('\n', ";").replace('\r', ";");
    let mm = 25.4 / dpi;
    let mut out = vec![];
    let mut cur: Vec<P> = vec![];
    let mut pen_down = false;
    let mut absolute = true;
    let (mut x, mut y) = (0.0f64, 0.0f64);
    let (mut pen, mut cur_pen): (i64, i64) = (1, 1);
    let mut pens: Vec<i64> = vec![];
    let pen_layer = |p: i64, pens: &mut Vec<i64>| -> String {
        let n = match pens.iter().position(|&q| q == p) {
            Some(i) => i + 1,
            None => {
                pens.push(p);
                pens.len()
            }
        };
        format!("Layer{}", n)
    };
    for cmd in text.split(';') {
        let cmd = py::strip(cmd);
        let chars: Vec<char> = cmd.chars().collect();
        if chars.len() < 2 {
            continue;
        }
        let op: String = chars[..2].iter().collect::<String>().to_uppercase();
        let args: String = chars[2..].iter().collect::<String>().replace(' ', ",");
        let nums: Vec<f64> = args.split(',').filter_map(py::parse_float).collect();
        if op == "SP" {
            if cur.len() > 1 {
                out.push(RawPath { layer: pen_layer(cur_pen, &mut pens), pts: std::mem::take(&mut cur), closed: false });
            }
            cur = vec![];
            pen = nums.first().map(|v| *v as i64).unwrap_or(1);
        }
        if matches!(op.as_str(), "PA" | "PR" | "PU" | "PD") {
            if op == "PA" {
                absolute = true;
            }
            if op == "PR" {
                absolute = false;
            }
            if op == "PU" {
                if cur.len() > 1 {
                    out.push(RawPath { layer: pen_layer(cur_pen, &mut pens), pts: std::mem::take(&mut cur), closed: false });
                }
                cur = vec![];
                pen_down = false;
            }
            if op == "PD" {
                pen_down = true;
            }
            let mut i = 0;
            while i + 1 < nums.len() {
                let (nx, ny) = if absolute { (nums[i], nums[i + 1]) } else { (x + nums[i], y + nums[i + 1]) };
                if pen_down {
                    if cur.is_empty() {
                        cur = vec![(x * mm, y * mm)];
                        cur_pen = pen;
                    }
                    cur.push((nx * mm, ny * mm));
                }
                x = nx;
                y = ny;
                i += 2;
            }
        }
    }
    if cur.len() > 1 {
        out.push(RawPath { layer: pen_layer(cur_pen, &mut pens), pts: cur, closed: false });
    }
    for p in out.iter_mut() {
        p.closed = p.pts.len() > 2 && geom::dist(p.pts[0], p.pts[p.pts.len() - 1]) < 1e-3;
    }
    out
}

// ------------------------------------------------------------------------------------------- DST (Tajima)

fn dst_decode(b0: u8, b1: u8, b2: u8) -> (i64, i64) {
    let bit = |v: u8, n: u32| ((v >> n) & 1) as i64;
    let x = bit(b0, 0) - bit(b0, 1) + 9 * bit(b0, 2) - 9 * bit(b0, 3) + 3 * bit(b1, 0) - 3 * bit(b1, 1) + 27 * bit(b1, 2) - 27 * bit(b1, 3)
        + 81 * bit(b2, 2)
        - 81 * bit(b2, 3);
    let y = bit(b0, 7) - bit(b0, 6) + 9 * bit(b0, 5) - 9 * bit(b0, 4) + 3 * bit(b1, 7) - 3 * bit(b1, 6) + 27 * bit(b1, 5) - 27 * bit(b1, 4)
        + 81 * bit(b2, 5)
        - 81 * bit(b2, 4);
    (x, y)
}

pub fn read_dst(data: &[u8]) -> Vec<RawPath> {
    let body = if data.len() > 512 { &data[512..] } else { data };
    let mut out = vec![];
    let mut cur: Vec<P> = vec![];
    let (mut x, mut y) = (0.0f64, 0.0f64);
    let mut color = 1;
    let mut i = 0;
    while i + 2 < body.len() {
        let (b0, b1, b2) = (body[i], body[i + 1], body[i + 2]);
        i += 3;
        if b2 == 0xF3 {
            break;
        }
        let (dx, dy) = dst_decode(b0, b1, b2);
        x += dx as f64 * 0.1;
        y += dy as f64 * 0.1;
        let jump = b2 & 0x80 != 0;
        let stop = b2 & 0x40 != 0 && jump;
        if jump {
            if cur.len() > 1 {
                out.push(RawPath { layer: format!("Layer{}", color), pts: std::mem::take(&mut cur), closed: false });
            }
            cur = vec![];
            if stop {
                color += 1;
            }
            continue;
        }
        if cur.is_empty() {
            cur = vec![(x - dx as f64 * 0.1, y - dy as f64 * 0.1)];
        }
        cur.push((x, y));
    }
    if cur.len() > 1 {
        out.push(RawPath { layer: format!("Layer{}", color), pts: cur, closed: false });
    }
    out
}

// ------------------------------------------------------------------------------------------- DSB (Barudan)

pub fn read_dsb(data: &[u8]) -> Vec<RawPath> {
    let body = if data.len() > 512 { &data[512..] } else { data };
    let mut out = vec![];
    let mut cur: Vec<P> = vec![];
    let (mut x, mut y) = (0.0f64, 0.0f64);
    let mut color = 1;
    let mut i = 0;
    while i + 2 < body.len() {
        let (ctrl, by, bx) = (body[i], body[i + 1] as i64, body[i + 2] as i64);
        i += 3;
        if ctrl == 0xF8 {
            break;
        }
        let dy = if ctrl & 0x40 != 0 { -by } else { by };
        let dx = if ctrl & 0x20 != 0 { -bx } else { bx };
        let low = ctrl & 0x1F;
        if low == 0 && ctrl < 0xE0 {
            if cur.is_empty() {
                cur = vec![(x * 0.1, y * 0.1)];
            }
            x += dx as f64;
            y += dy as f64;
            cur.push((x * 0.1, y * 0.1));
            continue;
        }
        if low == 1 && ctrl < 0xE0 {
            x += dx as f64;
            y += dy as f64;
        }
        if cur.len() > 1 {
            out.push(RawPath { layer: format!("Layer{}", color), pts: std::mem::take(&mut cur), closed: false });
        }
        cur = vec![];
        if (0xE9..0xF8).contains(&ctrl) {
            color += 1;
        }
    }
    if cur.len() > 1 {
        out.push(RawPath { layer: format!("Layer{}", color), pts: cur, closed: false });
    }
    out
}

// ------------------------------------------------------------------------------------------- AI (Illustrator: PostScript or PDF based)

fn tok_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?-u)%[^\r\n]*|\((?:\\.|[^\\)])*\)|<<|>>|\[|\]|/[^\s/\[\]()<>{}%]+|[^\s/\[\]()<>{}%]+").unwrap())
}

fn ps_paths(stream: &[u8], scale: f64) -> Vec<RawPath> {
    let mut out: Vec<RawPath> = vec![];
    let mut cur: Vec<P> = vec![];
    let mut nums: Vec<f64> = vec![];
    let mut pos: P = (0.0, 0.0);
    let mut start: Option<P> = None;

    fn flush(out: &mut Vec<RawPath>, cur: &mut Vec<P>, closed: bool) {
        if cur.len() > 1 {
            let c = closed || (cur.len() > 2 && geom::dist(cur[0], cur[cur.len() - 1]) < 1e-6);
            out.push(RawPath { layer: "Layer1".into(), pts: std::mem::take(cur), closed: c });
        }
        cur.clear();
    }
    fn bez(cur: &mut Vec<P>, p0: P, p1: P, p2: P, p3: P) {
        for i in 1..13 {
            let t = i as f64 / 12.0;
            let a = py::pow(1.0 - t, 3.0);
            let b = 3.0 * t * py::pow(1.0 - t, 2.0);
            let c = 3.0 * t * t * (1.0 - t);
            let d = py::pow(t, 3.0);
            cur.push((a * p0.0 + b * p1.0 + c * p2.0 + d * p3.0, a * p0.1 + b * p1.1 + c * p2.1 + d * p3.1));
        }
    }

    for m in tok_re().find_iter(stream) {
        let tok = m.as_bytes();
        if matches!(tok.first(), Some(b'%' | b'(' | b'/' | b'[' | b']' | b'<')) {
            nums.clear();
            continue;
        }
        let s: String = tok.iter().map(|&b| b as char).collect();
        if let Some(v) = py::parse_float(&s) {
            nums.push(v);
            continue;
        }
        let op = s.as_str();
        let n: Vec<f64> = nums.iter().map(|v| v * scale).collect();
        let k = n.len();
        match op {
            "m" if k >= 2 => {
                flush(&mut out, &mut cur, false);
                pos = (n[k - 2], n[k - 1]);
                cur = vec![pos];
                start = Some(pos);
            }
            "l" | "L" if k >= 2 => {
                pos = (n[k - 2], n[k - 1]);
                if cur.is_empty() {
                    cur = vec![pos];
                }
                cur.push(pos);
            }
            "c" | "C" if k >= 6 => {
                let (p1, p2, p3) = ((n[k - 6], n[k - 5]), (n[k - 4], n[k - 3]), (n[k - 2], n[k - 1]));
                if cur.is_empty() {
                    cur = vec![pos];
                }
                bez(&mut cur, pos, p1, p2, p3);
                pos = p3;
            }
            "v" | "V" if k >= 4 => {
                let (p2, p3) = ((n[k - 4], n[k - 3]), (n[k - 2], n[k - 1]));
                if cur.is_empty() {
                    cur = vec![pos];
                }
                bez(&mut cur, pos, pos, p2, p3);
                pos = p3;
            }
            "y" | "Y" if k >= 4 => {
                let (p1, p3) = ((n[k - 4], n[k - 3]), (n[k - 2], n[k - 1]));
                if cur.is_empty() {
                    cur = vec![pos];
                }
                bez(&mut cur, pos, p1, p3, p3);
                pos = p3;
            }
            "re" if k >= 4 => {
                flush(&mut out, &mut cur, false);
                let (x, y, w, h) = (n[k - 4], n[k - 3], n[k - 2], n[k - 1]);
                cur = vec![(x, y), (x + w, y), (x + w, y + h), (x, y + h)];
                flush(&mut out, &mut cur, true);
            }
            "h" => {
                if let Some(st) = start {
                    if !cur.is_empty() && geom::dist(cur[cur.len() - 1], st) > 1e-6 {
                        cur.push(st);
                    }
                }
            }
            "S" | "s" | "f" | "F" | "f*" | "B" | "B*" | "b" | "b*" | "n" | "N" => {
                flush(&mut out, &mut cur, matches!(op, "s" | "b" | "b*" | "f" | "F" | "f*"));
            }
            _ => {}
        }
        nums.clear();
    }
    flush(&mut out, &mut cur, false);
    out
}

fn find(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if from > hay.len() {
        return None;
    }
    hay[from..].windows(needle.len()).position(|w| w == needle).map(|i| i + from)
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    find(hay, needle, 0).is_some()
}

pub fn read_ai(data: &[u8]) -> Res<Vec<RawPath>> {
    static STREAM: OnceLock<Regex> = OnceLock::new();
    static MOVE: OnceLock<Regex> = OnceLock::new();
    let stream_re = STREAM.get_or_init(|| Regex::new(r"(?s-u)<<(.*?)>>\s*stream\r?\n").unwrap());
    let move_re = MOVE.get_or_init(|| Regex::new(r"(?-u)[\d.]\s+[-\d.]+\s+m\b").unwrap());
    let scale = 25.4 / 72.0;
    let mut streams: Vec<Vec<u8>> = vec![];
    if contains(&data[..data.len().min(1024)], b"%PDF-") {
        for c in stream_re.captures_iter(data) {
            let m = c.get(0).unwrap();
            let end = match find(data, b"endstream", m.end()) {
                Some(e) => e,
                None => data.len().saturating_sub(1), // data[m.end():-1]
            };
            let mut raw = if end > m.end() { data[m.end()..end].to_vec() } else { vec![] };
            let dic = c.get(1).unwrap().as_bytes();
            if contains(dic, b"/Image") {
                continue;
            }
            if contains(dic, b"FlateDecode") {
                match miniz_oxide::inflate::decompress_to_vec_zlib(&raw) {
                    Ok(v) => raw = v,
                    Err(e) => {
                        if e.status == miniz_oxide::inflate::TINFLStatus::FailedCannotMakeProgress {
                            raw = e.output; // a cut-off stream: keep what was decompressed
                        } else {
                            continue;
                        }
                    }
                }
            }
            if move_re.is_match(&raw) {
                streams.push(raw);
                break; // the first page content stream holds the artwork
            }
        }
    } else {
        let a = find(data, b"%%EndSetup", 0);
        let a = match a {
            Some(i) if i > 0 => i,
            _ => 0,
        };
        streams.push(data[a..].to_vec());
    }
    let mut out = vec![];
    for st in &streams {
        out.extend(ps_paths(st, scale));
    }
    if out.is_empty() {
        return Err(Error::op(
            "No drawing paths were found in this AI file. Save it from Illustrator as \"Illustrator 8\" or as DXF and try again.",
        ));
    }
    Ok(out)
}

// ------------------------------------------------------------------------------------------- any

const NOT_YET: [&str; 5] = [".edi", ".tzf", ".hlw", ".dig", ".klw"];

pub fn read_any(path: &str, dpi: f64) -> Res<Vec<RawPath>> {
    let ext = crate::platform::splitext(path).1.to_lowercase();
    let known = matches!(ext.as_str(), ".dxf" | ".plt" | ".hpgl" | ".prt" | ".dst" | ".dsb" | ".ai" | ".slw");
    if !known {
        let e = ext.to_uppercase();
        let e = e.trim_start_matches('.');
        if NOT_YET.contains(&ext.as_str()) {
            return Err(Error::Op(format!("{} files cannot be opened yet. Save the drawing as DXF and open that.", e)));
        }
        return Err(Error::Op(format!("{} files cannot be opened. Supported: DXF, AI, PLT, PRT, DST, DSB and SLW.", e)));
    }
    let data = std::fs::read(path).map_err(|e| Error::Unexpected(crate::platform::os_error(&e, std::path::Path::new(path))))?;
    match ext.as_str() {
        ".dxf" => read_dxf(&data),
        ".plt" | ".hpgl" | ".prt" => Ok(read_plt(&data, dpi)),
        ".dst" => Ok(read_dst(&data)),
        ".dsb" => Ok(read_dsb(&data)),
        ".ai" => read_ai(&data),
        _ => crate::machine::read_slw(&data).map_err(Error::Op),
    }
}
