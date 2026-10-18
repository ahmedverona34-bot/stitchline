//! Writers: DXF drawing, HPGL/PLT plot, SVG picture and CSV stitch list. (port of engine/exporters.py)
use crate::geom::P;
use crate::model::{get_b, get_f, Job};
use crate::py::{self, fixed};
use crate::stitches::{path_of, StitchMap};
use std::path::Path;

fn layer_name(name: &str) -> String {
    let n: String = name.chars().map(|c| if "<>/\\\":;?*|=,'".contains(c) { '_' } else { c }).collect();
    let n = py::strip(&n);
    let n = if n.is_empty() { "0" } else { n };
    n.chars().take(31).collect()
}

fn scale(job: &Job) -> (f64, f64) {
    let j = &job.settings;
    if get_b(j, "out_scale_on") {
        (get_f(j, "out_scale_x", 100.0) / 100.0, get_f(j, "out_scale_y", 100.0) / 100.0)
    } else {
        (1.0, 1.0)
    }
}

fn write(path: &Path, data: &[u8]) -> Result<(), String> {
    std::fs::write(path, data).map_err(|e| crate::platform::os_error(&e, path))
}

/// Write an AutoCAD R12 DXF. mode 'geometry': every sewn shape as drawn; 'stitches': every needle position.
pub fn dxf_text(job: &Job, stitched: Option<&StitchMap>, mode: &str) -> (String, usize) {
    let (sx, sy) = scale(job);
    let seq = job.sewn_shapes();
    let s = |v: &str| v.to_string();
    let mut out: Vec<String> = ["0", "SECTION", "2", "HEADER", "9", "$ACADVER", "1", "AC1009", "9", "$INSBASE", "10", "0.0", "20", "0.0", "30", "0.0"]
        .iter()
        .map(|v| s(v))
        .collect();
    let (x0, y0, x1, y1) = job.bounds();
    out.extend([
        s("9"), s("$EXTMIN"), s("10"), fixed(x0 * sx, 4), s("20"), fixed(y0 * sy, 4), s("30"), s("0.0"),
        s("9"), s("$EXTMAX"), s("10"), fixed(x1 * sx, 4), s("20"), fixed(y1 * sy, 4), s("30"), s("0.0"), s("0"), s("ENDSEC"),
    ]);
    let lname = |sh: &crate::model::Shape| layer_name(&job.layer(&sh.layer).map(|l| l.name.clone()).unwrap_or_default());
    let mut layers: Vec<String> = vec![];
    for sh in &seq {
        let nm = lname(sh);
        if !layers.contains(&nm) {
            layers.push(nm);
        }
    }
    out.extend([s("0"), s("SECTION"), s("2"), s("TABLES"), s("0"), s("TABLE"), s("2"), s("LAYER"), s("70"), layers.len().to_string()]);
    for (i, nm) in layers.iter().enumerate() {
        out.extend([s("0"), s("LAYER"), s("2"), nm.clone(), s("70"), s("0"), s("62"), (i % 6 + 1).to_string(), s("6"), s("CONTINUOUS")]);
    }
    out.extend(["0", "ENDTAB", "0", "ENDSEC", "0", "SECTION", "2", "ENTITIES"].iter().map(|v| s(v)));
    let mut count = 0;
    for sh in &seq {
        let nm = lname(sh);
        let (pts, closed): (Vec<P>, bool) = match (mode == "stitches", stitched) {
            (true, Some(st)) => (st.get(&sh.id).map(|v| v.0.clone()).unwrap_or_default(), false),
            _ => (sh.pts.clone(), sh.closed),
        };
        let pts: Vec<P> = pts.iter().map(|&(x, y)| (x * sx, y * sy)).collect();
        if pts.is_empty() {
            continue;
        }
        count += 1;
        if pts.len() == 1 {
            out.extend([s("0"), s("POINT"), s("8"), nm.clone(), s("10"), fixed(pts[0].0, 4), s("20"), fixed(pts[0].1, 4), s("30"), s("0.0")]);
        } else if pts.len() == 2 && !closed {
            out.extend([
                s("0"), s("LINE"), s("8"), nm.clone(), s("10"), fixed(pts[0].0, 4), s("20"), fixed(pts[0].1, 4), s("30"), s("0.0"),
                s("11"), fixed(pts[1].0, 4), s("21"), fixed(pts[1].1, 4), s("31"), s("0.0"),
            ]);
        } else {
            out.extend([
                s("0"), s("POLYLINE"), s("8"), nm.clone(), s("66"), s("1"), s("10"), s("0.0"), s("20"), s("0.0"), s("30"), s("0.0"), s("70"),
                s(if closed { "1" } else { "0" }),
            ]);
            for &(x, y) in &pts {
                out.extend([s("0"), s("VERTEX"), s("8"), nm.clone(), s("10"), fixed(x, 4), s("20"), fixed(y, 4), s("30"), s("0.0")]);
            }
            out.extend([s("0"), s("SEQEND"), s("8"), nm.clone()]);
        }
    }
    out.extend(["0", "ENDSEC", "0", "EOF"].iter().map(|v| s(v)));
    (out.join("\n") + "\n", count)
}

pub fn write_dxf(job: &Job, path: &Path, stitched: Option<&StitchMap>, mode: &str) -> Result<usize, String> {
    let (text, n) = dxf_text(job, stitched, mode);
    // ASCII with '?' for other characters, Windows line ends
    let data: String = text.chars().map(|c| if c.is_ascii() { c } else { '?' }).collect();
    write(path, data.replace('\n', "\r\n").as_bytes())?;
    Ok(n)
}

/// Write an HPGL plot file (.plt): one pen per layer, shapes in sewing order, dpi plotter units per inch.
pub fn plt_text(job: &Job, stitched: Option<&StitchMap>, mode: &str, dpi: f64) -> (String, usize) {
    let (sx, sy) = scale(job);
    let k = dpi / 25.4;
    let seq = job.sewn_shapes();
    let mut shapes: Vec<(&crate::model::Shape, Vec<P>)> = vec![];
    for sh in seq {
        let pts: Vec<P> = match (mode == "stitches", stitched) {
            (true, Some(st)) => st.get(&sh.id).map(|v| v.0.clone()).unwrap_or_default(),
            _ => {
                let mut p = sh.pts.clone();
                if sh.closed && sh.pts.len() > 2 {
                    p.push(sh.pts[0]);
                }
                p
            }
        };
        if !pts.is_empty() {
            shapes.push((sh, pts.iter().map(|&(x, y)| (x * sx, y * sy)).collect()));
        }
    }
    // plotters do not take negative coordinates: move the drawing up / right when it has any
    let xs = py::fmin(shapes.iter().flat_map(|(_, p)| p.iter().map(|q| q.0))).unwrap_or(0.0);
    let ys = py::fmin(shapes.iter().flat_map(|(_, p)| p.iter().map(|q| q.1))).unwrap_or(0.0);
    let ox = if xs < 0.0 { xs } else { 0.0 };
    let oy = if ys < 0.0 { ys } else { 0.0 };
    let mut pens: Vec<&str> = vec![];
    let mut out = vec!["IN".to_string()];
    let mut pen: Option<usize> = None;
    for (sh, pts) in &shapes {
        let p = match pens.iter().position(|l| *l == sh.layer) {
            Some(i) => i + 1,
            None => {
                pens.push(&sh.layer);
                pens.len()
            }
        };
        if Some(p) != pen {
            out.push(format!("SP{}", p));
            pen = Some(p);
        }
        let u: Vec<(i64, i64)> = pts.iter().map(|&(x, y)| (py::round_int((x - ox) * k), py::round_int((y - oy) * k))).collect();
        out.push(format!("PU{},{}", u[0].0, u[0].1));
        if u.len() == 1 {
            out.push(format!("PD{},{}", u[0].0, u[0].1)); // a point: pen down where it is
        } else {
            out.push(format!("PD{}", u[1..].iter().map(|q| format!("{},{}", q.0, q.1)).collect::<Vec<_>>().join(",")));
        }
    }
    out.push("PU".into());
    out.push("SP0".into());
    (out.join(";\n") + ";\n", shapes.len())
}

pub fn write_plt(job: &Job, path: &Path, stitched: Option<&StitchMap>, mode: &str, dpi: f64) -> Result<usize, String> {
    let (text, n) = plt_text(job, stitched, mode, dpi);
    write(path, text.as_bytes())?;
    Ok(n)
}

pub fn svg_text(job: &Job, stitched: &StitchMap) -> String {
    let (x0, y0, x1, y1) = job.bounds();
    let pad = 5.0;
    let (w, h) = ((x1 - x0) + pad * 2.0, (y1 - y0) + pad * 2.0);
    let mut parts = vec![
        format!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"{} {} {} {}\" width=\"{}mm\" height=\"{}mm\">",
            fixed(x0 - pad, 3), fixed(-y1 - pad, 3), fixed(w, 3), fixed(h, 3), fixed(w, 3), fixed(h, 3)
        ),
        format!("<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" fill=\"#ffffff\"/>", fixed(x0 - pad, 3), fixed(-y1 - pad, 3), fixed(w, 3), fixed(h, 3)),
    ];
    for s in &job.shapes {
        let Some(l) = job.layer(&s.layer) else { continue };
        let pts = path_of(s);
        let pp = pts.iter().map(|&(x, y)| format!("{},{}", fixed(x, 3), fixed(-y, 3))).collect::<Vec<_>>().join(" ");
        if !l.output {
            parts.push(format!("<polyline points=\"{}\" fill=\"none\" stroke=\"#9a9aa3\" stroke-width=\"0.3\" stroke-dasharray=\"2 1.4\"/>", pp));
            continue;
        }
        parts.push(format!("<polyline points=\"{}\" fill=\"none\" stroke=\"{}\" stroke-width=\"0.25\" opacity=\"0.5\"/>", pp, l.color));
        if let Some((sp, _)) = stitched.get(&s.id) {
            for &(x, y) in sp {
                parts.push(format!("<circle cx=\"{}\" cy=\"{}\" r=\"0.35\" fill=\"{}\"/>", fixed(x, 3), fixed(-y, 3), l.color));
            }
        }
    }
    parts.push("</svg>".into());
    parts.join("\n")
}

pub fn write_svg(job: &Job, path: &Path, stitched: &StitchMap) -> Result<(), String> {
    // a Python text file: Windows line ends
    write(path, svg_text(job, stitched).replace('\n', "\r\n").as_bytes())
}

pub fn csv_text(job: &Job, stitched: &StitchMap) -> String {
    let mut out = String::from("order,shape,layer,needle,stitch,x_mm,y_mm,kind\n");
    let bounds = job.bounds();
    for (i, s) in job.sewn_shapes().iter().enumerate() {
        let Some(l) = job.layer(&s.layer) else { continue };
        let Some((pts, flags)) = stitched.get(&s.id) else { continue };
        let name = if s.name.is_empty() { format!("Shape {}", s.id) } else { s.name.clone() };
        for (k, (p, fl)) in pts.iter().zip(flags.chars()).enumerate() {
            let (x, y) = crate::program::machine_xy_b(&job.settings, bounds, *p);
            out.push_str(&format!(
                "{},{},{},{},{},{},{},{}\n",
                i + 1,
                name.replace(',', " "),
                l.name.replace(',', " "),
                l.needle,
                k + 1,
                fixed(x, 3),
                fixed(y, 3),
                fl
            ));
        }
    }
    out
}

pub fn write_csv(job: &Job, path: &Path, stitched: &StitchMap) -> Result<(), String> {
    write(path, csv_text(job, stitched).as_bytes())
}
