//! SLW machine files: write a job for the sewing machine, and read SLW files back as drawings.
//! (port of engine/machine.py — see there for the record layout)
use crate::geom::{self, P};
use crate::model::{get_bd, get_i, Job, Map};
use crate::program::{event_items, instruction_records, job_defaults, machine_xy_b, Rec};
use crate::py;
use crate::slw_container;
use crate::stitches::StitchMap;
use serde_json::Value;
use std::collections::BTreeMap;

const PI_M: f64 = 3.1415926535; // the machine format's own value of pi, used for directions

pub type Record = (u16, u16, u32, u32, u32);

// ------------------------------------------------------------------ record layer

fn swap_dword(v: u32) -> [u8; 4] {
    [(v >> 8) as u8, v as u8, (v >> 24) as u8, (v >> 16) as u8]
}

fn unswap_dword(x: &[u8]) -> u32 {
    x[1] as u32 | ((x[0] as u32) << 8) | ((x[3] as u32) << 16) | ((x[2] as u32) << 24)
}

pub fn key_from_rec33(rec4: u32, rec8: u32) -> u16 {
    let (ebx, edx) = (rec4, rec8);
    let (mut ah, mut al): (u32, u32) = (0, 0);
    if ebx & 0x40000 != 0 {
        ah = 0x80;
    }
    if ebx & 0x2000000 == 0 {
        ah |= 0x40;
    }
    if ebx & 0x400 != 0 {
        ah |= 0x20;
    }
    if ebx & 0x10000 != 0 {
        ah |= 0x10;
    }
    if ebx & 0x80 == 0 {
        ah |= 8;
    }
    if (ebx as i32) > 0x5882 {
        ah |= 4;
    }
    if ebx & 1 != 0 {
        ah |= 2;
    }
    if ebx & 8 != 0 {
        ah |= 1;
    }
    if edx & 0x8000 != 0 {
        al |= 0x80;
    }
    let e = ((edx ^ 0xFFFFFFF3) as i32) >> 2;
    al |= (e & 0x7F) as u32;
    let k = ((ah << 8) | al) as u16;
    if k == 0xFFFF { 0xFF01 } else { k }
}

/// The 0x33 record: a time stamp mixed with a check value.
pub fn key_record(stamp: u32, check: u32) -> Record {
    let rec4 = stamp ^ check;
    let rec8 = (stamp ^ 0xB879C033) ^ (check / 3);
    let rec12 = rec8 ^ rec4 ^ 0x9672A1D6;
    let w1 = ((rec12 & 0xFFFF) ^ 0x3356) as u16;
    (0x33, w1, rec4, rec8, rec12)
}

pub fn encode_records(recs: &[Record]) -> Vec<u8> {
    let mut out = Vec::with_capacity(recs.len() * 16);
    let mut key: Option<u16> = None;
    let mut ctr: u32 = 0x3E7B;
    for &(code, w1, d4, d8, d12) in recs {
        match key {
            None => {
                out.extend_from_slice(&[(code >> 8) as u8, code as u8, (w1 >> 8) as u8, w1 as u8]);
                out.extend_from_slice(&swap_dword(d4));
                out.extend_from_slice(&swap_dword(d8));
                out.extend_from_slice(&swap_dword(d12));
                if code == 0x33 {
                    key = Some(key_from_rec33(d4, d8));
                }
            }
            Some(kv) => {
                let k = ((ctr ^ kv as u32) & 0xFFFF) as u16;
                ctr += 3;
                let kk = k as u32 | ((k as u32) << 16);
                out.extend_from_slice(&(code ^ k).to_le_bytes());
                out.extend_from_slice(&(w1 ^ k).to_le_bytes());
                out.extend_from_slice(&(d4 ^ kk).to_le_bytes());
                out.extend_from_slice(&(d8 ^ kk).to_le_bytes());
                out.extend_from_slice(&(d12 ^ kk).to_le_bytes());
            }
        }
    }
    out
}

pub fn decode_records(body: &[u8]) -> Vec<Record> {
    let mut out = vec![];
    let mut key: Option<u16> = None;
    let mut ctr: u32 = 0x3E7B;
    let mut off = 0;
    while off + 16 <= body.len() {
        let r = &body[off..off + 16];
        off += 16;
        match key {
            None => {
                let rec = be_record(r);
                out.push(rec);
                if rec.0 == 0x33 {
                    key = Some(key_from_rec33(rec.2, rec.3));
                }
            }
            Some(kv) => {
                let k = ((ctr ^ kv as u32) & 0xFFFF) as u16;
                ctr += 3;
                let kk = k as u32 | ((k as u32) << 16);
                let u16at = |i: usize| u16::from_le_bytes([r[i], r[i + 1]]);
                let u32at = |i: usize| u32::from_le_bytes([r[i], r[i + 1], r[i + 2], r[i + 3]]);
                out.push((u16at(0) ^ k, u16at(2) ^ k, u32at(4) ^ kk, u32at(8) ^ kk, u32at(12) ^ kk));
            }
        }
    }
    out
}

/// A record stored big-endian, as before the 0x33 record.
fn be_record(r: &[u8]) -> Record {
    let code = ((r[0] as u16) << 8) | r[1] as u16;
    let w1 = ((r[2] as u16) << 8) | r[3] as u16;
    (code, w1, unswap_dword(&r[4..8]), unswap_dword(&r[8..12]), unswap_dword(&r[12..16]))
}

// ------------------------------------------------------------------ files from newer Sew_Soft versions

/// Newer Sew_Soft versions mark their 0x33 record with `w1 = d12 ^ 0x47AB` instead of `d12 = d4 ^ d8 ^ 0x9672A1D6`.
/// After it the records stay big-endian, and every byte is XORed with a key byte that changes every X bytes
/// (X depends on the file, e.g. 1128 or 5275), cycling through these 16 values XORed with a per-file constant.
/// The key schedule itself is not known, so it is measured from the file: the w1 word of almost every record
/// is 0, so its two bytes show the key.
const SEG_KEYS: [u8; 16] = [0x90, 0x85, 0x9F, 0xB8, 0xBD, 0x99, 0x9E, 0xC0, 0xA4, 0xB3, 0xD1, 0x81, 0xB9, 0x18, 0x06, 0x93];

/// Records of an SLW body (after the outer container), in either the 180112 format or the newer one.
pub fn read_records(body: &[u8]) -> Vec<Record> {
    let recs = decode_records(body);
    let Some(i33) = recs.iter().position(|r| r.0 == 0x33) else { return recs };
    let (_, w1, d4, d8, d12) = recs[i33];
    if d4 ^ d8 ^ 0x9672A1D6 == d12 || (d12 as u16) ^ 0x47AB != w1 {
        return recs;
    }
    let start = (i33 + 1) * 16;
    let end = body.len() / 16 * 16;
    let plain = |keys: &dyn Fn(usize) -> u8| -> Vec<Record> {
        let mut b = body[..end].to_vec();
        for (p, v) in b.iter_mut().enumerate().skip(start) {
            *v ^= keys(p - start);
        }
        b.chunks_exact(16).map(be_record).collect()
    };

    // the code's high byte and the w1 bytes are mostly 0, so two of them that agree show the key;
    // runs of records with the same key, where short runs are stray non-zero bytes
    let mut runs: Vec<(usize, usize, u8, usize)> = vec![]; // first byte, last byte, key, probes
    for p in (start..end).step_by(16) {
        let (b0, b2, b3) = (body[p], body[p + 2], body[p + 3]);
        let (first, last, k) = if b2 == b3 {
            (p + 2, p + 3, b2)
        } else if b0 == b3 {
            (p, p + 3, b0)
        } else if b0 == b2 {
            (p, p + 2, b0)
        } else {
            continue;
        };
        match runs.last_mut() {
            Some(r) if r.2 == k => {
                r.1 = last;
                r.3 += 1;
            }
            _ => runs.push((first, last, k, 1)),
        }
    }
    let mut segs: Vec<(usize, usize, u8)> = vec![];
    for r in runs.into_iter().filter(|r| r.3 >= 4) {
        match segs.last_mut() {
            Some(s) if s.2 == r.2 => s.1 = r.1,
            _ => segs.push((r.0, r.1, r.2)),
        }
    }
    let Some(&(_, _, k0)) = segs.first() else { return recs };
    if segs.len() == 1 {
        return plain(&|_| k0);
    }

    // the key of segment j: from the 16-value cycle when the file follows it, else as measured
    let vals: Vec<u8> = segs.iter().map(|s| s.2).collect();
    let cycle = (0..16).find(|&s| vals.iter().enumerate().all(|(j, &v)| v == SEG_KEYS[(s + j) % 16] ^ SEG_KEYS[s] ^ k0));
    let key_of = |j: usize| match cycle {
        Some(s) => SEG_KEYS[(s + j) % 16] ^ SEG_KEYS[s] ^ k0,
        None => vals[j.min(vals.len() - 1)],
    };

    // boundary j (1-based) lies at offset j*X - q0 from `start`; each run pair bounds it
    let iv: Vec<(i64, i64)> = (1..segs.len()).map(|j| ((segs[j - 1].1 + 1 - start) as i64, (segs[j].0 - start) as i64)).collect();
    let mut cands: Vec<(i64, i64)> = vec![];
    if iv.len() == 1 {
        cands.extend((iv[0].0..=iv[0].1).map(|q| (q, 0)));
    } else {
        let (first, last, n) = (iv[0], iv[iv.len() - 1], iv.len() as i64 - 1);
        let xlo = (last.0 - first.1 + n - 1).div_euclid(n);
        let xhi = (last.1 - first.0).div_euclid(n);
        for x in xlo.max(1)..=xhi {
            let (mut lo, mut hi) = (i64::MIN, i64::MAX);
            for (j, &(a, b)) in iv.iter().enumerate() {
                let jx = (j as i64 + 1) * x;
                lo = lo.max(jx - b);
                hi = hi.min(jx - a);
            }
            cands.extend((lo..=hi).map(|q0| (x, q0)));
            if cands.len() > 400 {
                break;
            }
        }
    }
    let decode_with = |x: i64, q0: i64| plain(&|q| key_of((q as i64 + q0).div_euclid(x).max(0) as usize));
    let best = cands.iter().map(|&(x, q0)| (implausibility(&decode_with(x, q0)[i33 + 1..]), x, q0)).min();
    match best {
        Some((_, x, q0)) => decode_with(x, q0),
        // no steady segment length: switch keys where the next run starts
        None => plain(&|q| key_of(iv.iter().take_while(|&&(_, b)| q as i64 >= b).count())),
    }
}

/// How unlikely decoded records are: unknown codes, coordinates out of range, and points that stick out of
/// the line through their neighbours (a byte decoded with the wrong key moves a point by 0.25 mm or more).
fn implausibility(recs: &[Record]) -> i64 {
    const FAR: i64 = 1_000_000;
    let mut bad = 0;
    let mut pts: Vec<(i64, i64)> = vec![];
    for &(code, w1, d4, d8, _) in recs {
        if code > 0xFF && code >> 8 != 0x75 {
            bad += FAR;
        } else if matches!(code, 0x1E | 0x34 | 0x35 | 0x7595) || (code == 0x43 && w1 == 0) {
            let (x, y) = (s32(d4), s32(d8));
            if x.abs() > 10_000_000 || y.abs() > 10_000_000 {
                bad += FAR;
            } else {
                pts.push((x, y));
            }
        }
    }
    for w in pts.windows(3) {
        let (dx, dy) = (2 * w[1].0 - w[0].0 - w[2].0, 2 * w[1].1 - w[0].1 - w[2].1);
        bad += (dx.abs() + dy.abs()).min(FAR);
    }
    bad
}

pub fn s32(v: u32) -> i64 {
    v as i32 as i64
}

// ------------------------------------------------------------------ directions

/// Direction from (x0, y0) to (x1, y1) in machine units (degrees x 64, 0..23039).
pub fn direction(x0: i64, y0: i64, x1: i64, y1: i64) -> i64 {
    if x0 == x1 && y0 == y1 {
        return 0;
    }
    let (dx, dy) = ((x1 - x0) as f64, (y1 - y0) as f64);
    let d = py::hypot(dx, dy);
    let mut a = py::asin((-1.0f64).max((dy / d).min(1.0)));
    if x1 - x0 < 0 {
        a = if y1 - y0 < 0 { -PI_M - a } else { PI_M - a };
    }
    if a < 0.0 {
        a += 6.28318530702; // constants exactly as the machine program uses them
    }
    ((a * 3666.9298889304046) as i64) & 0xFFFF
}

// ------------------------------------------------------------------ writer

/// Job name as the machine program stores it: the file name with its '.' turned into a 0 byte, 16 bytes at most.
fn name_records(file_name: &str) -> [Rec; 2] {
    let raw: Vec<u8> = file_name.chars().map(|c| if c.is_ascii() { c as u8 } else { b'?' }).collect();
    let dot = raw.iter().rposition(|&c| c == b'.');
    let (stem_len, mut raw) = match dot {
        Some(i) => {
            let mut r = raw[..i].to_vec();
            r.push(0);
            r.extend_from_slice(&raw[i + 1..]);
            (i, r)
        }
        None => (raw.len(), raw),
    };
    raw.truncate(16);
    raw.resize(16, 0);
    let w: Vec<i64> = (0..4).map(|i| u32::from_be_bytes([raw[i * 4], raw[i * 4 + 1], raw[i * 4 + 2], raw[i * 4 + 3]]) as i64).collect();
    [[0x36, stem_len as i64, w[0], w[1], w[2]], [0x37, 0, w[3], 0, 0]] // length of the whole name, even past 16
}

/// Indices of points where the stitch direction turns by at least `angle` degrees.
fn turns(pts: &[(i64, i64)], angle: f64) -> Vec<usize> {
    let f = |p: (i64, i64)| (p.0 as f64, p.1 as f64);
    let mut out = vec![];
    for i in 1..pts.len().saturating_sub(1) {
        if geom::turn_angle(f(pts[i - 1]), f(pts[i]), f(pts[i + 1])) >= angle - 1e-9 {
            out.push(i);
        }
    }
    out
}

#[derive(Clone, Debug)]
enum Item {
    Rec(Rec),
    Move(i64, i64),
    Stitch(i64, i64),
}

const INDEX_ERR: &str = "list index out of range";

/// Program items for one stitch-mode shape, the way the machine program lays them out.
///
/// Back-tacks at the ends of open lines are bracketed by 0x47 records; corners get 0x2A markers
/// (0 = slow down from here, 1 = at the corner, 2 = back to speed).
fn shape_items(ls: &Map, mp: &[(i64, i64)], flags: &[u8]) -> Result<(Vec<Item>, bool), String> {
    let n = mp.len() as i64;
    let fl = |i: i64| -> u8 { flags.get(i as usize).copied().unwrap_or(b' ') };
    let mut h: i64 = 0; // back-tack at the start: points 1..h
    while h + 1 < n && fl(h + 1) == b'b' && h < n / 2 {
        h += 1;
    }
    let mut t: i64 = 0; // back-tack at the end: the last t points
    while t < n - h - 2 && fl(n - 1 - t) == b'b' {
        t += 1;
    }
    let mut base: Vec<i64> = vec![0];
    base.extend((h + 1)..(n - t)); // positions of the shape's own stitches
    let mut before: BTreeMap<i64, Vec<i64>> = BTreeMap::new();
    let mut after: BTreeMap<i64, Vec<i64>> = BTreeMap::new();
    let slow = get_i(ls, "corner_slow_n", 5);
    let bpts: Vec<(i64, i64)> = base.iter().map(|&i| mp[i as usize]).collect();
    let angle = crate::model::get_f(ls, "corner_angle", 45.0);
    let bl = base.len() as i64;
    let bget = |i: i64| -> Result<i64, String> {
        let j = if i < 0 { bl + i } else { i };
        if j < 0 || j >= bl { Err(INDEX_ERR.into()) } else { Ok(base[j as usize]) }
    };
    for v in turns(&bpts, angle) {
        let v = v as i64;
        before.entry(bget(0.max(v - (slow - 2)))?).or_default().push(0);
        after.entry(bget(v)?).or_default().push(1);
        after.entry(bget((bl - 1).min(v + slow + 1))?).or_default().push(2);
    }
    let mut items = vec![];
    for j in 0..n {
        if let Some(ms) = before.get(&j) {
            for &m in ms {
                items.push(Item::Rec([0x2A, 0, m, 0, 0]));
            }
        }
        if j == 0 && h != 0 {
            items.push(Item::Rec([0x47, 0, 0, 0xFFFF, 0]));
        }
        if t != 0 && j == n - t {
            items.push(Item::Rec([0x47, 0, 0, 0xFFFF, 0]));
        }
        let p = mp[j as usize];
        items.push(Item::Stitch(p.0, p.1));
        if h != 0 && j == h {
            items.push(Item::Rec([0x47, 0, 1, 0xFFFF, 0]));
        }
        if let Some(ms) = after.get(&j) {
            for &m in ms {
                items.push(Item::Rec([0x2A, 0, m, 0, 0]));
            }
        }
    }
    Ok((items, t != 0))
}

/// Turn program items into records, following the machine program's writer (Sew_Soft 0x480b40).
fn write_items(items: &[Item]) -> (Vec<Rec>, i64, f64) {
    let mut body: Vec<Rec> = vec![];
    let (mut move_mode, mut section, mut initial) = (true, 0i64, false);
    let mut cur_f: Option<usize> = None;
    let (mut hist_len, mut steady): (i64, i64) = (99999, 0);
    let mut prev: (i64, i64) = (-5, 0);
    let mut n_f = 0i64;
    let mut sewn = 0.0f64;
    for it in items {
        let (x, y, is_move) = match *it {
            Item::Rec(r) => {
                body.push(r);
                continue;
            }
            Item::Move(x, y) => (x, y, true),
            Item::Stitch(x, y) => (x, y, false),
        };
        let hyp = || py::hypot((x - prev.0) as f64, (y - prev.1) as f64);
        if is_move {
            initial = false;
            if !move_mode {
                move_mode = true;
                section = 1;
            }
            if section != 0 {
                body.push([0x14, 0, 0, 0, 0]);
                body.push([0x0F, 0, 0, 0, 0]);
                cur_f = Some(body.len() - 1);
                n_f += 1;
                let l = hyp() as i64; // travel length
                let last = body.len() - 1;
                body[last][4] = l;
                section = 0;
            }
            body.push([0x1E, 0, x, y, 0]);
            prev = (x, y);
            continue;
        }
        // a needle position
        let mut first = false;
        if move_mode {
            move_mode = false;
            first = true;
            if section == 0 {
                section = 1;
            }
            initial = false;
        }
        if section != 0 {
            body.push([0x14, 0, 0, 0, 0]);
            body.push([0x0F, 0, 1, 0, 1000]);
            cur_f = Some(body.len() - 1);
            n_f += 1;
            initial = true;
            steady = 0;
            hist_len = 99999;
            section = 0;
        }
        let length = hyp() as i64;
        sewn += if !first { hyp() } else { 0.0 };
        let cf = cur_f.unwrap_or(0);
        if initial {
            body[cf][4] = body[cf][4].max(length);
            if length > 800 {
                initial = false;
            }
        } else if (length - body[cf][4]).abs() < 0xC9 {
            if steady > 0 {
                steady += 1;
                if steady > 5 {
                    steady = 0;
                    if (hist_len - body[cf][4]).abs() < 0x50 {
                        body[cf][4] = hist_len;
                    }
                }
            }
        } else {
            // stitch length changed: new section
            body.push([0x14, 0, 0, 0, 0]);
            body.push([0x0F, 0, 1, 0, length]);
            cur_f = Some(body.len() - 1);
            n_f += 1;
            steady = 1;
            hist_len = length;
        }
        if first && prev != (x, y) {
            body.push([0x7595, 0, prev.0, prev.1, 0]);
        }
        body.push([0x7595, 0, x, y, 0]);
        prev = (x, y);
    }
    (body, n_f, sewn)
}

/// Direction words and 0x47 values, as the machine program's backward pass sets them.
fn set_directions(body: &mut [Rec]) {
    let mut refp: Option<(i64, i64)> = None;
    let mut later: usize = 0;
    let mut prev_ang: i64 = -99999;
    let mut bracket: Option<usize> = None;
    let mut pending: i64 = 0xFFFF;
    let mut first_move: Option<usize> = None;
    for idx in (0..body.len()).rev() {
        let code = body[idx][0];
        if code == 0x47 {
            bracket = Some(idx);
            if body[idx][2] == 0 {
                bracket = None;
                body[idx][3] = pending;
                pending = 0xFFFF;
            }
        } else if code == 0x1E || code == 0x7595 {
            let (rx, ry) = (body[idx][2], body[idx][3]);
            let Some(rp) = refp else {
                refp = Some((rx, ry));
                later = idx;
                if (body[idx][1] & 0xFF00) == 0xF300 {
                    body[idx][4] |= 0xFFFF0000;
                }
                continue;
            };
            let mut ang = direction(rx, ry, rp.0, rp.1);
            if (rx, ry) == rp && prev_ang > -999 {
                ang = prev_ang;
            }
            prev_ang = ang;
            if (body[later][1] & 0xFF00) == 0xF300 {
                body[later][4] = (body[later][4] & 0xFFFF) | (ang << 16);
            } else {
                body[later][1] = 0xF300;
                body[later][4] = (ang << 16) | 0xFFFF;
            }
            if code == 0x7595 {
                if bracket.is_none() {
                    pending = (body[later][4] >> 16) & 0xFFFF;
                }
            } else {
                first_move = Some(idx);
            }
            refp = Some((rx, ry));
            later = idx;
        }
    }
    if let Some(fm) = first_move {
        if (body[fm][1] & 0xFF00) != 0xF300 {
            body[fm][1] = 0xF300 | (body[fm][1] & 0xFF);
        }
    }
}

/// Local time fields (year, mon 1-12, mday, hour, min, sec) of a Unix time stamp, or of now.
/// STITCHLINE_FIXED_TIME (Unix seconds) pins the time stamp, so tests can compare whole files.
pub fn local_time(stamp: Option<i64>) -> (i64, i64, i64, i64, i64, i64) {
    let fixed = || std::env::var("STITCHLINE_FIXED_TIME").ok().and_then(|v| v.parse::<i64>().ok());
    crate::platform::local_time(stamp.or_else(fixed))
}

/// Logical records for a job (before the record and container scrambling).
pub fn build_records(job: &Job, stitched: &StitchMap, file_name: &str, stamp: Option<i64>) -> Result<Vec<Record>, String> {
    let jset = &job.settings;
    let bounds = job.bounds();
    let to_um = |p: P| -> (i64, i64) {
        let (x, y) = machine_xy_b(jset, bounds, p);
        (py::round_int(x * 1000.0), py::round_int(y * 1000.0))
    };
    let mut items: Vec<Item> = vec![];
    let defaults = job_defaults(job);
    let emit_extra = |items: &mut Vec<Item>, anchor: &Value| {
        for it in &job.program_extra {
            if py::py_eq(&it.before, anchor) {
                for r in instruction_records(&it.name, &Value::String(it.value.clone())) {
                    items.push(Item::Rec(r));
                }
            }
        }
    };
    let event = |items: &mut Vec<Item>, name: &str| {
        for (n, v) in event_items(&defaults, name) {
            for r in instruction_records(&n, &v) {
                items.push(Item::Rec(r));
            }
        }
    };

    let mut layer_marks = 0i64;
    let mut cur_layer: Option<&str> = None;
    let mut cur_needle: Option<i64> = None;
    let mut bracket_open = false;
    event(&mut items, "Job start");
    let empty: (Vec<P>, String) = (vec![], String::new());
    for s in job.sewn_shapes() {
        let Some(l) = job.layer(&s.layer) else { continue };
        let (pts, flags) = stitched.get(&s.id).unwrap_or(&empty);
        if pts.is_empty() {
            continue;
        }
        if bracket_open {
            // a back-tack bracket left open by the previous shape
            items.push(Item::Rec([0x47, 0, 1, 0xFFFF, 0]));
            bracket_open = false;
        }
        emit_extra(&mut items, &serde_json::json!(s.id));
        if cur_layer != Some(l.id.as_str()) {
            // [head end] 0x29 (new needle, previous needle, 0-based) [head start] 0x25 (layer count)
            if cur_layer.is_some() {
                event(&mut items, "Layer end");
            }
            let new = 1.max(3.min(l.needle));
            if let Some(cn @ (2 | 3)) = cur_needle {
                if new != cn {
                    event(&mut items, &format!("Head {} end", cn));
                }
            }
            items.push(Item::Rec([0x29, 0, new - 1, cur_needle.unwrap_or(1) - 1, 0]));
            if (new == 2 || new == 3) && Some(new) != cur_needle {
                event(&mut items, &format!("Head {} start", new));
            }
            items.push(Item::Rec([0x25, 0, layer_marks, 0, 0]));
            layer_marks += 1;
            event(&mut items, "Layer start");
            cur_layer = Some(l.id.as_str());
            cur_needle = Some(new);
        }
        let start = to_um(pts[0]);
        items.push(Item::Move(start.0, start.1)); // travel to the start (a point: move there only)
        let convert = get_bd(&l.settings, "convert", true);
        if pts.len() == 1 {
            if convert {
                items.push(Item::Move(start.0, start.1)); // with "Line to point" the machine program writes the point twice
            }
            continue;
        }
        let head = matches!(cur_needle, Some(2 | 3));
        let cn = cur_needle.unwrap_or(1);
        event(&mut items, "Shape start");
        if head {
            event(&mut items, &format!("Head {} shape start", cn));
        }
        event(&mut items, "Sewing start");
        if convert {
            event(&mut items, "Stitch shape start");
            let mp: Vec<(i64, i64)> = pts.iter().map(|&p| to_um(p)).collect();
            let (si, open) = shape_items(&l.settings, &mp, flags.as_bytes())?;
            items.extend(si);
            bracket_open = open;
            event(&mut items, "Before sewing end");
            event(&mut items, "Stitch shape end");
        } else {
            items.push(Item::Rec([0x43, 0, start.0, start.1, 0])); // sewing on
            for &p in &pts[1..] {
                let q = to_um(p);
                items.push(Item::Move(q.0, q.1));
            }
            event(&mut items, "Before sewing end");
            items.push(Item::Rec([0x43, 1, 0, 0, 0])); // sewing off
        }
        if head {
            event(&mut items, &format!("Head {} shape end", cn));
        }
        event(&mut items, "Sewing end");
        event(&mut items, "Shape end");
    }
    if let Some(cn @ (2 | 3)) = cur_needle {
        event(&mut items, &format!("Head {} end", cn));
    }
    if cur_layer.is_some() {
        event(&mut items, "Layer end");
    }
    emit_extra(&mut items, &serde_json::json!("end"));
    event(&mut items, "Job end");

    let (mut body, n_f, sewn) = write_items(&items);
    if !body.iter().any(|r| r[0] == 0x25) {
        // empty job: the header still has the first layer's marks
        let mut b = vec![[0x29, 0, 0, 0, 0], [0x25, 0, 0, 0, 0]];
        b.extend(body);
        body = b;
    }
    set_directions(&mut body);
    // extents over all point records (and reference points)
    let (mut xs, mut ys): (Vec<i64>, Vec<i64>) = (vec![], vec![]);
    let mut n_points = 0i64;
    for r in &body {
        if r[0] == 0x1E || r[0] == 0x7595 {
            xs.push(s32(r[2] as u32));
            ys.push(s32(r[3] as u32));
            n_points += 1;
        }
    }
    let mut refs = vec![];
    for k in ["r1", "r2"] {
        if let Some(sid) = job.ref_shape(k) {
            let Some(sh) = job.shape(sid) else { continue };
            let Some(&p0) = sh.pts.first() else { return Err(INDEX_ERR.into()) };
            let p = to_um(p0);
            refs.push(p);
            xs.push(p.0);
            ys.push(p.1);
        }
    }
    let w = if xs.is_empty() { 0 } else { xs.iter().max().unwrap() - xs.iter().min().unwrap() };
    let h = if ys.is_empty() { 0 } else { ys.iter().max().unwrap() - ys.iter().min().unwrap() };
    for r in body.iter_mut() {
        if r[0] == 0x7595 {
            r[0] = 0x34;
        } else if r[0] == 0x1E {
            r[0] = 0x35;
        }
    }
    let mut head: Vec<Rec> = vec![
        [0x00, 0x55, 0, 0, n_f + 2],
        [0x0E, 0, 0, 0, 10000 | (10000 << 16)],
        [0x0D, 0, n_points, w, h],
        [0x0F, 0, 0, 0, 0],
        [0x14, 0, 0, 0, 0],
        [0x0F, 0, 0, 0, 0],
        [0x2C, 0, (sewn / 1000.0) as i64, 0, 0],
    ];
    for (x, y) in refs {
        head.push([0x31, 0, 2, x, y]);
    }
    head.extend(name_records(file_name));
    let mut check: i64 = 0;
    for r in &body {
        check = ((r[0] + check) | (r[2] & 0xFFFFFFFF)) & 0xFFFFFFFF;
    }
    let (year, mon, mday, hour, min, sec) = local_time(stamp);
    let st = year + sec * 9 + ((mon + min * 3 + (hour + mday * 8) * 2) * 2);
    let rec33 = key_record(st as u32, check as u32);
    let tail: Vec<Rec> = if body.last().map(|r| r[0]) != Some(0x14) { vec![[0x14, 0, 0, 0, 0]] } else { vec![] };
    let mut recs: Vec<Rec> = head;
    recs.push([rec33.0 as i64, rec33.1 as i64, rec33.2 as i64, rec33.3 as i64, rec33.4 as i64]);
    recs.extend(body);
    recs.extend(tail);
    recs.push([0x01, 0, 0, 0, 0]);
    let n = recs.len() as i64;
    recs[0][2] = n;
    Ok(recs
        .into_iter()
        .map(|r| ((r[0] & 0xFFFF) as u16, (r[1] & 0xFFFF) as u16, (r[2] & 0xFFFFFFFF) as u32, (r[3] & 0xFFFFFFFF) as u32, (r[4] & 0xFFFFFFFF) as u32))
        .collect())
}

/// The bytes of an SLW file for a job.
pub fn slw_bytes(job: &Job, stitched: &StitchMap, file_name: &str, stamp: Option<i64>) -> Result<(Vec<u8>, usize), String> {
    let recs = build_records(job, stitched, file_name, stamp)?;
    let body = encode_records(&recs);
    let (header, scrambled) = slw_container::encode(&body)?;
    let mut out = header.to_vec();
    out.extend(scrambled);
    Ok((out, recs.len()))
}

pub fn write_slw(job: &Job, stitched: &StitchMap, path: &std::path::Path) -> Result<usize, String> {
    let name = crate::platform::basename(&path.to_string_lossy());
    let (bytes, n) = slw_bytes(job, stitched, &name, None)?;
    std::fs::write(path, bytes).map_err(|e| crate::platform::os_error(&e, path))?;
    Ok(n)
}

// ------------------------------------------------------------------ reader (open .slw as a drawing)

pub fn read_slw(data: &[u8]) -> Result<Vec<crate::importers::RawPath>, String> {
    use crate::importers::RawPath;
    if data.len() < 48 {
        return Err("This file is too short to be a machine file.".into());
    }
    let body = slw_container::decode(data)?;
    let recs = read_records(&body);
    if recs.is_empty() || recs[0].0 != 0 || !recs.iter().any(|r| r.0 == 0x33) {
        return Err("This is not an SLW machine file.".into());
    }
    let mut out: Vec<RawPath> = vec![];
    let mut cur: Vec<P> = vec![];
    let mut sewing = false;
    let mut last: Option<P> = None;
    for &(code, w1, d4, d8, _) in &recs {
        let p = (s32(d4) as f64 / 1000.0, s32(d8) as f64 / 1000.0);
        if code == 0x43 {
            if w1 == 0 {
                sewing = true;
                cur = last.map(|l| vec![l]).unwrap_or_default();
            } else {
                if cur.len() > 1 {
                    out.push(RawPath { layer: "Layer1".into(), pts: std::mem::take(&mut cur), closed: false });
                }
                cur = vec![];
                sewing = false;
            }
        } else if code == 0x34 || code == 0x35 || code == 0x1E {
            // 0x1E: the newer versions' 0x35
            if sewing {
                cur.push(p);
            } else if cur.len() > 1 {
                // a move ends a run of 0x7595 stitches
                out.push(RawPath { layer: "Layer1".into(), pts: std::mem::take(&mut cur), closed: false });
            }
            last = Some(p);
        } else if code == 0x7595 {
            // newer versions: a stitch that is sewn without a 0x43 before it
            if cur.is_empty() {
                cur = last.map(|l| vec![l]).unwrap_or_default();
            }
            cur.push(p);
            last = Some(p);
        } else if code == 0x01 {
            break;
        }
    }
    if cur.len() > 1 {
        out.push(RawPath { layer: "Layer1".into(), pts: cur, closed: false });
    }
    for o in out.iter_mut() {
        if o.pts.len() > 2 && geom::dist(o.pts[0], o.pts[o.pts.len() - 1]) < 1e-6 {
            o.pts.pop();
            o.closed = true;
        }
    }
    if out.is_empty() {
        if let Some(l) = last {
            out.push(RawPath { layer: "Layer1".into(), pts: vec![l], closed: false });
        }
    }
    Ok(out)
}
