//! SLW outer container: 32-byte header and 512-byte window scrambling. (port of engine/slw_container.py)

const SIG: [u8; 5] = [0xF0, 0x2A, 0xC3, 0x68, 0x33];

type Table = [(u32, usize, u8); 8];

// (value bit, header index, header bit) for each byte of the window offset and the XOR key
const OFF_B3: Table = [(0x80, 1, 4), (0x40, 1, 0x20), (0x20, 1, 0x10), (0x10, 1, 0x80), (8, 11, 0x80), (4, 12, 0x20), (2, 13, 4), (1, 14, 0x40)];
const OFF_B2: Table = [(0x80, 2, 8), (0x40, 2, 0x20), (0x20, 3, 1), (0x10, 3, 0x40), (8, 4, 2), (4, 4, 0x10), (2, 4, 0x40), (1, 4, 0x80)];
const OFF_B1: Table = [(1, 5, 0x80), (2, 5, 0x40), (4, 5, 0x20), (8, 5, 0x10), (0x10, 6, 0x20), (0x20, 6, 8), (0x40, 6, 2), (0x80, 6, 1)];
const OFF_B0: Table = [(0x80, 7, 0x10), (0x40, 7, 2), (0x20, 8, 0x40), (0x10, 8, 8), (8, 9, 8), (4, 9, 0x20), (2, 10, 4), (1, 10, 0x10)];
const OFF_MASK: [(usize, u8); 14] = [
    (1, 0x4B), (2, 0xD7), (3, 0xBE), (4, 0x2D), (5, 0x0F), (6, 0xD4), (7, 0xED), (8, 0xB7), (9, 0xD7), (10, 0xEB), (11, 0x7F), (12, 0xDF), (13, 0xFB), (14, 0xBF),
];
const KEY_B3: Table = [(1, 21, 0x20), (2, 21, 0x80), (4, 21, 8), (8, 21, 2), (0x10, 22, 0x80), (0x20, 22, 0x20), (0x40, 22, 8), (0x80, 22, 2)];
const KEY_B2: Table = [(0x80, 23, 8), (0x40, 23, 0x40), (0x20, 23, 0x10), (0x10, 23, 4), (8, 24, 1), (4, 24, 8), (2, 24, 0x40), (1, 24, 0x80)];
const KEY_B1: Table = [(1, 25, 0x80), (2, 25, 0x20), (4, 25, 8), (8, 25, 0x40), (0x10, 26, 1), (0x20, 26, 8), (0x40, 26, 0x20), (0x80, 26, 0x40)];
const KEY_B0: Table = [(0x80, 27, 0x20), (0x40, 27, 4), (0x20, 28, 0x10), (0x10, 28, 0x40), (8, 29, 8), (4, 29, 0x20), (2, 30, 0x40), (1, 30, 2)];
const KEY_MASK: [(usize, u8); 10] = [(21, 0x55), (22, 0x55), (23, 0xA3), (24, 0x36), (25, 0x17), (26, 0x96), (27, 0xDB), (28, 0xAF), (29, 0xD7), (30, 0xBD)];

fn put(h: &mut [u8; 32], value: u32, table: &Table) {
    for &(vbit, idx, hbit) in table {
        if value & vbit != 0 {
            h[idx] |= hbit;
        }
    }
}

fn get(h: &[u8], table: &Table) -> u32 {
    let mut v = 0;
    for &(vbit, idx, hbit) in table {
        if h[idx] & hbit != 0 {
            v |= vbit;
        }
    }
    v
}

fn window_offset(b: &[u8], n: usize) -> usize {
    if n < 600 {
        return 0;
    }
    let mut off = ((n & 0xFF) ^ ((n >> 8) & 0xFF) ^ ((n >> 16) & 0xFF) ^ ((n >> 24) & 0xFF)) + b[(n >> 2) + 5] as usize;
    if b[n >> 3] != 0 {
        off += n >> 4;
    }
    if n < off + 0x201 {
        off = (n - 0x200) / 2;
    }
    if off + 0x201 <= n {
        return off;
    }
    off >> 1
}

/// (header32, scrambled body) exactly as XH_NewConvert(body, len, 0, header).
pub fn encode(body: &[u8]) -> Result<([u8; 32], Vec<u8>), String> {
    let mut b = body.to_vec();
    let n = b.len();
    if n == 0 {
        return Err("empty body".into());
    }
    let last = n - 1;
    let pick = |b: &Vec<u8>, i: usize| b[i.min(last)];
    let mut h = [0u8; 32];
    let mid = n >> 1;
    h[0] = b[mid] ^ ((n >> 24) & 0xFF) as u8;
    h[1] = pick(&b, n - (n >> 3)) ^ ((n >> 16) & 0xFF) as u8;
    h[2] = pick(&b, n - (n >> 2)) ^ ((n >> 8) & 0xFF) as u8;
    let t = pick(&b, n - (n >> 5));
    h[4] = h[0] ^ 0x33;
    h[3] = t ^ (n & 0xFF) as u8;
    h[5] = h[1] ^ b[mid];
    h[6] = pick(&b, n - (n >> 6)) ^ h[2];
    h[7] = pick(&b, (n >> 6) + (n >> 5)) ^ h[3];
    for i in 0..8usize {
        h[i + 8] = pick(&b, (n >> ((i + 1) & 31)) + (n >> (i & 31))) ^ i as u8;
    }
    for i in 0x15..0x1Fusize {
        h[i] = pick(&b, (n >> ((i + 1) & 31)) + (n >> (i & 31))) ^ i as u8;
    }
    h[0x10..0x15].copy_from_slice(&SIG);
    h[0] = if n < 0x200 { h[0] & 0xFD } else { h[0] | 2 };
    let off = window_offset(&b, n);
    if n > 0x1FF {
        for &(idx, m) in &OFF_MASK {
            h[idx] &= m;
        }
        let off32 = off as u32;
        put(&mut h, (off32 >> 24) & 0xFF, &OFF_B3);
        put(&mut h, (off32 >> 16) & 0xFF, &OFF_B2);
        put(&mut h, (off32 >> 8) & 0xFF, &OFF_B1);
        put(&mut h, off32 & 0xFF, &OFF_B0);
        let s: u64 = (0..0x28).map(|j| b[(off >> 1) + j] as u64).sum();
        let key: u32 = ((((s << 16) & 0xFFFF_FFFF) as u32) | (off32 & 0xFFFF)) ^ 0x36EA58C2;
        for &(idx, m) in &KEY_MASK {
            h[idx] &= m;
        }
        put(&mut h, (key >> 24) & 0xFF, &KEY_B3);
        put(&mut h, (key >> 16) & 0xFF, &KEY_B2);
        put(&mut h, (key >> 8) & 0xFF, &KEY_B1);
        put(&mut h, key & 0xFF, &KEY_B0);
        let kb = key.to_be_bytes();
        for i in 0..0x200 {
            b[off + i] ^= kb[i & 3];
        }
    }
    let mut x: u8 = 0x2C;
    for v in &h[..0x0F] {
        x ^= v;
    }
    h[0x0F] = x;
    let mut y: u8 = 0x55;
    for v in &h[0x15..0x1F] {
        y ^= v;
    }
    h[0x1F] = y;
    Ok((h, b))
}

/// Inverse of encode for a whole file (header + body). Returns the plain body.
pub fn decode(data: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() < 32 {
        return Err("This file is too short to be a machine file.".into());
    }
    let h = &data[..32];
    let mut b = data[32..].to_vec();
    if h[0] & 2 != 0 {
        if h[0x10..0x15] != SIG {
            return Err("bad signature".into());
        }
        let off = ((get(h, &OFF_B3) << 24) | (get(h, &OFF_B2) << 16) | (get(h, &OFF_B1) << 8) | get(h, &OFF_B0)) as usize;
        let kb = [get(h, &KEY_B3) as u8, get(h, &KEY_B2) as u8, get(h, &KEY_B1) as u8, get(h, &KEY_B0) as u8];
        if off + 0x200 > b.len() {
            return Err("index out of range".into());
        }
        for i in 0..0x200 {
            b[off + i] ^= kb[i & 3];
        }
    }
    Ok(b)
}
