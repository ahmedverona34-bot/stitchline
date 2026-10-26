//! Windows paths the way Python's os.path (ntpath) splits them, local time, and removable drives.

fn is_sep(c: char) -> bool {
    c == '\\' || c == '/'
}

/// Write a file through a temporary one beside it and rename it into place, so a crash or a power cut while
/// writing never leaves a half-written file where the user's project (or the machine file) used to be.
pub fn write_atomic(path: &std::path::Path, data: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = std::path::PathBuf::from(tmp);
    let res = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, path)
    })();
    if res.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    res
}

/// ntpath.splitdrive (drive letters and UNC shares)
pub fn splitdrive(p: &str) -> (&str, &str) {
    let b = p.as_bytes();
    if b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
        return (&p[..2], &p[2..]);
    }
    if b.len() >= 2 && is_sep(b[0] as char) && is_sep(b[1] as char) && !(b.len() > 2 && is_sep(b[2] as char)) {
        // \\server\share
        let rest = &p[2..];
        if let Some(i) = rest.find(is_sep) {
            let after = &rest[i + 1..];
            let j = after.find(is_sep).map(|j| 2 + i + 1 + j).unwrap_or(p.len());
            return (&p[..j], &p[j..]);
        }
        return (p, "");
    }
    ("", p)
}

/// ntpath.split
pub fn split(p: &str) -> (String, String) {
    let (d, rest) = splitdrive(p);
    let i = rest.rfind(is_sep).map(|i| i + 1).unwrap_or(0);
    let (head, tail) = (&rest[..i], &rest[i..]);
    let stripped = head.trim_end_matches(is_sep);
    let head = if stripped.is_empty() { head } else { stripped };
    (format!("{}{}", d, head), tail.to_string())
}

pub fn basename(p: &str) -> String {
    split(p).1
}

pub fn dirname(p: &str) -> String {
    split(p).0
}

/// ntpath.splitext
pub fn splitext(p: &str) -> (String, String) {
    let sep = p.rfind(is_sep).map(|i| i as i64).unwrap_or(-1);
    let dot = p.rfind('.').map(|i| i as i64).unwrap_or(-1);
    if dot > sep {
        let mut fi = sep + 1;
        while fi < dot {
            if p.as_bytes()[fi as usize] != b'.' {
                return (p[..dot as usize].to_string(), p[dot as usize..].to_string());
            }
            fi += 1;
        }
    }
    (p.to_string(), String::new())
}

/// os.path.join for two parts
pub fn join(a: &str, b: &str) -> String {
    if a.is_empty() || a.ends_with(is_sep) || (a.len() == 2 && a.ends_with(':')) {
        format!("{}{}", a, b)
    } else {
        format!("{}\\{}", a, b)
    }
}

/// Text of an OSError the way Python prints it.
pub fn os_error(e: &std::io::Error, path: &std::path::Path) -> String {
    let (no, text) = match e.kind() {
        std::io::ErrorKind::NotFound => (2, "No such file or directory".to_string()),
        std::io::ErrorKind::PermissionDenied => (13, "Permission denied".to_string()),
        _ => (e.raw_os_error().unwrap_or(5), e.to_string()),
    };
    format!("[Errno {}] {}: '{}'", no, text, path.display())
}

#[cfg(windows)]
mod win {
    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    pub struct SystemTime {
        pub year: u16,
        pub month: u16,
        pub day_of_week: u16,
        pub day: u16,
        pub hour: u16,
        pub minute: u16,
        pub second: u16,
        pub ms: u16,
    }
    #[link(name = "kernel32")]
    extern "system" {
        pub fn GetLocalTime(t: *mut SystemTime);
        pub fn FileTimeToSystemTime(ft: *const u64, st: *mut SystemTime) -> i32;
        pub fn SystemTimeToTzSpecificLocalTime(tz: *const u8, utc: *const SystemTime, local: *mut SystemTime) -> i32;
        pub fn GetLogicalDrives() -> u32;
        pub fn GetDriveTypeW(root: *const u16) -> u32;
    }
}

/// (year, month 1-12, day, hour, minute, second) in local time, of a Unix time stamp or of now.
#[cfg(windows)]
pub fn local_time(stamp: Option<i64>) -> (i64, i64, i64, i64, i64, i64) {
    let mut t = win::SystemTime::default();
    unsafe {
        match stamp {
            None => win::GetLocalTime(&mut t),
            Some(s) => {
                let ft: u64 = ((s + 11644473600) as u64) * 10_000_000;
                let mut utc = win::SystemTime::default();
                win::FileTimeToSystemTime(&ft, &mut utc);
                win::SystemTimeToTzSpecificLocalTime(std::ptr::null(), &utc, &mut t);
            }
        }
    }
    (t.year as i64, t.month as i64, t.day as i64, t.hour as i64, t.minute as i64, t.second as i64)
}

#[cfg(not(windows))]
pub fn local_time(stamp: Option<i64>) -> (i64, i64, i64, i64, i64, i64) {
    // UTC fallback (civil from days)
    let s = stamp.unwrap_or_else(|| std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0));
    let days = s.div_euclid(86400);
    let secs = s.rem_euclid(86400);
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d, secs / 3600, secs % 3600 / 60, secs % 60)
}

/// Roots of USB sticks and other removable drives, e.g. ["E:\\"].
#[cfg(windows)]
pub fn removable_drives() -> Vec<String> {
    let mut out = vec![];
    let mask = unsafe { win::GetLogicalDrives() };
    for i in 0..26u32 {
        if mask & (1 << i) != 0 {
            let root = format!("{}:\\", (b'A' + i as u8) as char);
            let w: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
            if unsafe { win::GetDriveTypeW(w.as_ptr()) } == 2 {
                out.push(root);
            }
        }
    }
    out
}

#[cfg(not(windows))]
pub fn removable_drives() -> Vec<String> {
    vec![]
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paths() {
        assert_eq!(basename("C:\\a\\b.slw"), "b.slw");
        assert_eq!(dirname("C:\\a\\b.slw"), "C:\\a");
        assert_eq!(dirname("C:\\b.slw"), "C:\\");
        assert_eq!(splitext("C:\\a.b\\c"), ("C:\\a.b\\c".to_string(), "".to_string()));
        assert_eq!(splitext("x/.dxf"), ("x/.dxf".to_string(), "".to_string()));
        assert_eq!(splitext("x/a.DXF").1, ".DXF");
        assert_eq!(join("E:\\", "a.slw"), "E:\\a.slw");
    }
}
