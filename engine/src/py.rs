//! Python number semantics the engine relies on, so results match the Python engine bit for bit:
//! math.hypot (CPython 3.12 algorithm), sum() of floats (Neumaier), round(), '%.Nf', repr(), float(),
//! str.split()/strip()/splitlines(), truthiness of JSON values, and the C runtime's sin/cos/atan2/...
//! (Python on Windows uses ucrtbase.dll; calling the same functions gives identical results).
use serde_json::Value;

// ------------------------------------------------------------------ C runtime math (same as Python's math module)

// Rust's own sin() differs from Python's math.sin in the last bit for about 14% of inputs, so the
// functions are taken from ucrtbase.dll at run time (it is part of every Windows 10/11).
#[cfg(windows)]
mod crt {
    use std::ffi::c_void;
    use std::sync::OnceLock;

    #[link(name = "kernel32")]
    extern "system" {
        fn LoadLibraryA(name: *const u8) -> *mut c_void;
        fn GetProcAddress(module: *mut c_void, name: *const u8) -> *mut c_void;
    }

    type F1 = extern "C" fn(f64) -> f64;
    type F2 = extern "C" fn(f64, f64) -> f64;

    pub struct Crt {
        pub sin: F1,
        pub cos: F1,
        pub atan: F1,
        pub asin: F1,
        pub acos: F1,
        pub atan2: F2,
        pub pow: F2,
    }

    extern "C" fn r_sin(x: f64) -> f64 { x.sin() }
    extern "C" fn r_cos(x: f64) -> f64 { x.cos() }
    extern "C" fn r_atan(x: f64) -> f64 { x.atan() }
    extern "C" fn r_asin(x: f64) -> f64 { x.asin() }
    extern "C" fn r_acos(x: f64) -> f64 { x.acos() }
    extern "C" fn r_atan2(y: f64, x: f64) -> f64 { y.atan2(x) }
    extern "C" fn r_pow(x: f64, y: f64) -> f64 { x.powf(y) }

    pub fn get() -> &'static Crt {
        static C: OnceLock<Crt> = OnceLock::new();
        C.get_or_init(|| unsafe {
            let m = LoadLibraryA(b"ucrtbase.dll\0".as_ptr());
            let f = |name: &[u8]| if m.is_null() { std::ptr::null_mut() } else { GetProcAddress(m, name.as_ptr()) };
            let f1 = |name: &[u8], fallback: F1| -> F1 {
                let p = f(name);
                if p.is_null() { fallback } else { std::mem::transmute::<*mut c_void, F1>(p) }
            };
            let f2 = |name: &[u8], fallback: F2| -> F2 {
                let p = f(name);
                if p.is_null() { fallback } else { std::mem::transmute::<*mut c_void, F2>(p) }
            };
            Crt {
                sin: f1(b"sin\0", r_sin),
                cos: f1(b"cos\0", r_cos),
                atan: f1(b"atan\0", r_atan),
                asin: f1(b"asin\0", r_asin),
                acos: f1(b"acos\0", r_acos),
                atan2: f2(b"atan2\0", r_atan2),
                pow: f2(b"pow\0", r_pow),
            }
        })
    }
}

#[cfg(windows)]
pub fn sin(x: f64) -> f64 { (crt::get().sin)(x) }
#[cfg(windows)]
pub fn cos(x: f64) -> f64 { (crt::get().cos)(x) }
#[cfg(windows)]
pub fn atan(x: f64) -> f64 { (crt::get().atan)(x) }
#[cfg(windows)]
pub fn atan2(y: f64, x: f64) -> f64 { (crt::get().atan2)(y, x) }
#[cfg(windows)]
pub fn asin(x: f64) -> f64 { (crt::get().asin)(x) }
#[cfg(windows)]
pub fn acos(x: f64) -> f64 { (crt::get().acos)(x) }
#[cfg(windows)]
pub fn pow(x: f64, y: f64) -> f64 { (crt::get().pow)(x, y) }

#[cfg(not(windows))]
pub fn sin(x: f64) -> f64 { x.sin() }
#[cfg(not(windows))]
pub fn cos(x: f64) -> f64 { x.cos() }
#[cfg(not(windows))]
pub fn atan(x: f64) -> f64 { x.atan() }
#[cfg(not(windows))]
pub fn atan2(y: f64, x: f64) -> f64 { y.atan2(x) }
#[cfg(not(windows))]
pub fn asin(x: f64) -> f64 { x.asin() }
#[cfg(not(windows))]
pub fn acos(x: f64) -> f64 { x.acos() }
#[cfg(not(windows))]
pub fn pow(x: f64, y: f64) -> f64 { x.powf(y) }

pub const PI: f64 = std::f64::consts::PI;

/// math.radians
pub fn radians(x: f64) -> f64 {
    let deg_to_rad = PI / 180.0;
    deg_to_rad * x
}

/// math.degrees
pub fn degrees(x: f64) -> f64 {
    let rad_to_deg = 180.0 / PI;
    rad_to_deg * x
}

// ------------------------------------------------------------------ math.hypot (CPython 3.12 vector_norm)

fn ldexp1(e: i32) -> f64 {
    // 2.0 ** e, exactly
    if e >= -1022 {
        f64::from_bits(((e + 1023) as u64) << 52)
    } else {
        f64::from_bits(1u64 << (52 + e + 1022))
    }
}

fn frexp_exp(x: f64) -> i32 {
    // exponent e with x = m * 2**e, 0.5 <= m < 1 (x > 0, finite)
    let bits = x.to_bits();
    let ex = ((bits >> 52) & 0x7ff) as i32;
    if ex == 0 {
        frexp_exp(x * ldexp1(54)) - 54
    } else {
        ex - 1022
    }
}

#[inline]
fn two_prod(a: f64, b: f64) -> (f64, f64) {
    // exact product (Dekker), same result as fma(a, b, -a*b)
    let p = a * b;
    const SPLIT: f64 = 134217729.0; // 2**27 + 1
    let t = SPLIT * a;
    let ah = t - (t - a);
    let al = a - ah;
    let t = SPLIT * b;
    let bh = t - (t - b);
    let bl = b - bh;
    let e = ((ah * bh - p) + ah * bl + al * bh) + al * bl;
    (p, e)
}

#[inline]
fn fast_sum(a: f64, b: f64) -> (f64, f64) {
    let x = a + b;
    let z = x - a;
    (x, b - z)
}

fn vector_norm(vec: &mut [f64], max: f64, found_nan: bool) -> f64 {
    if max.is_infinite() {
        return max;
    }
    if found_nan {
        return f64::NAN;
    }
    if max == 0.0 || vec.len() <= 1 {
        return max;
    }
    let max_e = frexp_exp(max);
    if max_e < -1023 {
        for v in vec.iter_mut() {
            *v /= f64::MIN_POSITIVE;
        }
        return f64::MIN_POSITIVE * vector_norm(vec, max / f64::MIN_POSITIVE, found_nan);
    }
    let scale = ldexp1(-max_e);
    let (mut csum, mut frac1, mut frac2) = (1.0f64, 0.0f64, 0.0f64);
    for &v in vec.iter() {
        let x = v * scale;
        let (hi, lo) = two_prod(x, x);
        let (shi, slo) = fast_sum(csum, hi);
        csum = shi;
        frac1 += lo;
        frac2 += slo;
    }
    let mut h = (csum - 1.0 + (frac1 + frac2)).sqrt();
    let (hi, lo) = two_prod(-h, h);
    let (shi, slo) = fast_sum(csum, hi);
    csum = shi;
    frac1 += lo;
    frac2 += slo;
    let x = csum - 1.0 + (frac1 + frac2);
    h += x / (2.0 * h);
    h / scale
}

/// math.hypot(x, y)
pub fn hypot(x: f64, y: f64) -> f64 {
    let mut v = [x.abs(), y.abs()];
    let found_nan = v[0].is_nan() || v[1].is_nan();
    let mut max = 0.0f64;
    for &a in &v {
        if a > max {
            max = a;
        }
    }
    vector_norm(&mut v, max, found_nan)
}

// ------------------------------------------------------------------ sum(), min(), max()

/// sum() of floats as CPython 3.12 does it (Neumaier compensated summation).
pub fn fsum<I: IntoIterator<Item = f64>>(it: I) -> f64 {
    let mut f = 0.0f64;
    let mut c = 0.0f64;
    let mut first = true;
    for x in it {
        if first {
            f = 0.0 + x; // int 0 + first float
            first = false;
            continue;
        }
        let t = f + x;
        if f.abs() >= x.abs() {
            c += (f - t) + x;
        } else {
            c += (x - t) + f;
        }
        f = t;
    }
    if c != 0.0 && c.is_finite() {
        f += c;
    }
    f
}

/// min() over floats: the first of the smallest values.
pub fn fmin<I: IntoIterator<Item = f64>>(it: I) -> Option<f64> {
    let mut best: Option<f64> = None;
    for x in it {
        match best {
            None => best = Some(x),
            Some(b) if x < b => best = Some(x),
            _ => {}
        }
    }
    best
}

/// max() over floats: the first of the largest values.
pub fn fmax<I: IntoIterator<Item = f64>>(it: I) -> Option<f64> {
    let mut best: Option<f64> = None;
    for x in it {
        match best {
            None => best = Some(x),
            Some(b) if x > b => best = Some(x),
            _ => {}
        }
    }
    best
}

/// Index of the first item with the smallest key (Python's min(range(n), key=...)).
pub fn argmin<F: FnMut(usize) -> f64>(n: usize, mut key: F) -> usize {
    let mut bi = 0;
    let mut bk = f64::NAN;
    for i in 0..n {
        let k = key(i);
        if i == 0 || k < bk {
            bi = i;
            bk = k;
        }
    }
    bi
}

// ------------------------------------------------------------------ rounding and formatting

/// round(x) -> int (ties to even)
pub fn round_int(x: f64) -> i64 {
    x.round_ties_even() as i64
}

/// round(x) as float (ties to even)
pub fn round0(x: f64) -> f64 {
    x.round_ties_even()
}

/// round(x, n) with n > 0: correctly rounded to n decimals (ties to even on the exact value).
pub fn round_n(x: f64, n: usize) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let s = format!("{:.*}", n, x);
    let r: f64 = s.parse().unwrap_or(x);
    if r == 0.0 {
        // Python keeps the sign of zero
        return if x.is_sign_negative() { -0.0 } else { 0.0 };
    }
    r
}

/// '%.Nf' % x
pub fn fixed(x: f64, n: usize) -> String {
    if x.is_nan() {
        return "nan".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "inf".into() } else { "-inf".into() };
    }
    format!("{:.*}", n, x)
}

/// repr(x) / str(x) of a float
pub fn float_repr(x: f64) -> String {
    if x.is_nan() {
        return "nan".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "inf".into() } else { "-inf".into() };
    }
    if x == 0.0 {
        return if x.is_sign_negative() { "-0.0".into() } else { "0.0".into() };
    }
    // shortest round-trip digits and decimal exponent
    let e = format!("{:e}", x);
    let (mant, exp) = e.split_once('e').unwrap();
    let exp: i32 = exp.parse().unwrap();
    let neg = mant.starts_with('-');
    let digits: String = mant.chars().filter(|c| c.is_ascii_digit()).collect();
    let nd = digits.len() as i32;
    let sign = if neg { "-" } else { "" };
    if (-4..16).contains(&exp) {
        // fixed notation
        let point = exp + 1; // digits before the decimal point
        let s = if point <= 0 {
            format!("0.{}{}", "0".repeat((-point) as usize), digits)
        } else if point >= nd {
            format!("{}{}.0", digits, "0".repeat((point - nd) as usize))
        } else {
            format!("{}.{}", &digits[..point as usize], &digits[point as usize..])
        };
        format!("{}{}", sign, s)
    } else {
        let m = if nd > 1 { format!("{}.{}", &digits[..1], &digits[1..]) } else { digits.clone() };
        format!("{}{}e{}{:02}", sign, m, if exp < 0 { '-' } else { '+' }, exp.abs())
    }
}

/// str(v) of a JSON value the way Python prints the decoded value.
pub fn py_str(v: &Value) -> String {
    match v {
        Value::Null => "None".into(),
        Value::Bool(b) => if *b { "True".into() } else { "False".into() },
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                i.to_string()
            } else if let Some(u) = n.as_u64() {
                u.to_string()
            } else {
                float_repr(n.as_f64().unwrap_or(0.0))
            }
        }
        Value::String(s) => s.clone(),
        Value::Array(a) => format!("[{}]", a.iter().map(py_repr).collect::<Vec<_>>().join(", ")),
        Value::Object(o) => format!(
            "{{{}}}",
            o.iter().map(|(k, v)| format!("{}: {}", py_repr(&Value::String(k.clone())), py_repr(v))).collect::<Vec<_>>().join(", ")
        ),
    }
}

/// repr(v) of a JSON value as Python prints the decoded value.
pub fn py_repr(v: &Value) -> String {
    match v {
        Value::String(s) => {
            if s.contains('\'') && !s.contains('"') {
                format!("\"{}\"", s.replace('\\', "\\\\"))
            } else {
                format!("'{}'", s.replace('\\', "\\\\").replace('\'', "\\'"))
            }
        }
        _ => py_str(v),
    }
}

// ------------------------------------------------------------------ strings

pub fn is_py_space(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\x0b' | '\x0c' | '\r' | '\x1c' | '\x1d' | '\x1e' | '\x1f' | ' ' | '\u{85}' | '\u{a0}'
        | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}')
}

/// str.strip()
pub fn strip(s: &str) -> &str {
    s.trim_matches(is_py_space)
}

/// str.split() with no separator
pub fn split_ws(s: &str) -> Vec<&str> {
    s.split(is_py_space).filter(|t| !t.is_empty()).collect()
}

/// str.splitlines()
pub fn splitlines(s: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let b = s.as_bytes();
    let mut start = 0;
    let mut it = s.char_indices().peekable();
    while let Some((i, c)) = it.next() {
        let brk = matches!(c, '\n' | '\r' | '\x0b' | '\x0c' | '\x1c' | '\x1d' | '\x1e' | '\u{85}' | '\u{2028}' | '\u{2029}');
        if brk {
            out.push(&s[start..i]);
            let mut end = i + c.len_utf8();
            if c == '\r' && end < b.len() && b[end] == b'\n' {
                it.next();
                end += 1;
            }
            start = end;
        }
    }
    if start < s.len() {
        out.push(&s[start..]);
    }
    out
}

/// float(s) for a string: None where Python raises ValueError.
pub fn parse_float(s: &str) -> Option<f64> {
    let t = strip(s);
    if t.is_empty() {
        return None;
    }
    let cleaned;
    let t = if t.contains('_') {
        // Python allows single underscores between digits
        let bytes: Vec<char> = t.chars().collect();
        for (i, c) in bytes.iter().enumerate() {
            if *c == '_' {
                let ok = i > 0 && i + 1 < bytes.len() && bytes[i - 1].is_ascii_digit() && bytes[i + 1].is_ascii_digit();
                if !ok {
                    return None;
                }
            }
        }
        cleaned = t.replace('_', "");
        cleaned.as_str()
    } else {
        t
    };
    if !t.is_ascii() {
        return None;
    }
    let low = t.to_ascii_lowercase();
    let body = low.trim_start_matches(['+', '-']);
    if body.len() + 1 < low.len() {
        return None; // more than one sign
    }
    match body {
        "inf" | "infinity" => return Some(if low.starts_with('-') { f64::NEG_INFINITY } else { f64::INFINITY }),
        "nan" => return Some(f64::NAN),
        _ => {}
    }
    if !body.chars().next().map(|c| c.is_ascii_digit() || c == '.').unwrap_or(false) {
        return None;
    }
    t.parse::<f64>().ok()
}

/// int(s) for a string: None where Python raises ValueError.
pub fn parse_int(s: &str) -> Option<i64> {
    let t = strip(s);
    let t = t.replace('_', "");
    if t.is_empty() || !t.is_ascii() {
        return None;
    }
    t.parse::<i64>().ok()
}

// ------------------------------------------------------------------ JSON values with Python semantics

/// bool(v)
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0).unwrap_or(false),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::Object(o)) => !o.is_empty(),
    }
}

/// float(v); None where Python raises.
pub fn to_float(v: &Value) -> Option<f64> {
    match v {
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        Value::Number(n) => n.as_f64(),
        Value::String(s) => parse_float(s),
        _ => None,
    }
}

/// int(v); None where Python raises.
pub fn to_int(v: &Value) -> Option<i64> {
    match v {
        Value::Bool(b) => Some(*b as i64),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Some(i)
            } else {
                n.as_f64().filter(|f| f.is_finite()).map(|f| f.trunc() as i64)
            }
        }
        Value::String(s) => parse_int(s),
        _ => None,
    }
}

/// Python == between two decoded JSON values (1 == 1.0).
pub fn py_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Bool(x), Value::Number(y)) | (Value::Number(y), Value::Bool(x)) => y.as_f64() == Some(*x as i64 as f64),
        _ => a == b,
    }
}

pub fn num(v: f64) -> Value {
    serde_json::Number::from_f64(v).map(Value::Number).unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repr_like_python() {
        assert_eq!(float_repr(1800.0), "1800.0");
        assert_eq!(float_repr(1e-5), "1e-05");
        assert_eq!(float_repr(1e16), "1e+16");
        assert_eq!(float_repr(2.2), "2.2");
        assert_eq!(float_repr(0.0001), "0.0001");
        assert_eq!(float_repr(123456789012345.6), "123456789012345.6");
        assert_eq!(float_repr(-1.5e-7), "-1.5e-07");
        assert_eq!(fixed(0.125, 2), "0.12");
        assert_eq!(round_n(2.675, 2), 2.67);
        assert_eq!(hypot(3.0, 4.0), 5.0);
        assert_eq!(splitlines("a\r\nb\rc\n"), vec!["a", "b", "c"]);
    }
}
