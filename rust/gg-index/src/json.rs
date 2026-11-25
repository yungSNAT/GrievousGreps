//! JSON with JavaScript's semantics, so Rust writes the bytes `src/graph/write.ts` writes.
//!
//! - Parsing follows `JSON.parse`: strict grammar, numbers as `f64`, a repeated key keeps
//!   its first position and takes its last value.
//! - Strings are UTF-16 code units, as in JavaScript, so a lone surrogate survives.
//! - Printing follows `JSON.stringify(value, null, 2)` (array-index keys first, then
//!   insertion order) followed by `asciiJson`, which escapes every unit from U+007F up.

use std::collections::HashMap;
use std::fmt::Write as _;

/// Deepest value accepted, the root being depth 0. TypeScript's `JSON.stringify` overflows
/// V8's stack at 3,657 levels on Windows and 4,150 on Linux (Node 26), and the limit moves
/// with platform and stack size, so the cap sits well below both: TypeScript writes every
/// graph inside it, and the parity harness checks the cap and one past it. Parsing,
/// printing and dropping recurse once a level: run them on a thread with [`STACK_BYTES`].
pub const MAX_DEPTH: usize = 2_000;

/// Stack that [`MAX_DEPTH`] levels of parsing, printing and dropping fit in, debug builds
/// included.
pub const STACK_BYTES: usize = 256 << 20;

/// Members an object holds before repeated keys are found through a hash index.
const INDEX_FROM: usize = 16;

#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(Vec<u16>),
    Arr(Vec<Json>),
    Obj(Vec<(Vec<u16>, Json)>),
}

impl Json {
    /// The value under `key` in an object, if any.
    pub fn get(&self, key: &str) -> Option<&Json> {
        let Json::Obj(members) = self else {
            return None;
        };
        let key = utf16(key);
        members.iter().find(|(k, _)| *k == key).map(|(_, v)| v)
    }
}

pub fn utf16(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

/// Parse `text` as `JSON.parse` would.
pub fn parse(text: &str) -> Result<Json, String> {
    let mut p = Parser {
        s: text.as_bytes(),
        i: 0,
    };
    p.ws();
    let v = p.value(0)?;
    p.ws();
    if p.i != p.s.len() {
        return Err(p.err("unexpected data after JSON"));
    }
    Ok(v)
}

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
}

impl Parser<'_> {
    fn err(&self, what: &str) -> String {
        format!("invalid JSON at byte {}: {what}", self.i)
    }

    fn ws(&mut self) {
        while matches!(self.s.get(self.i), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.i += 1;
        }
    }

    fn eat(&mut self, lit: &str) -> bool {
        let ok = self.s[self.i..].starts_with(lit.as_bytes());
        if ok {
            self.i += lit.len();
        }
        ok
    }

    fn value(&mut self, depth: usize) -> Result<Json, String> {
        if depth > MAX_DEPTH {
            return Err(self.err("nested too deeply"));
        }
        match self.s.get(self.i) {
            Some(b'{') => self.object(depth),
            Some(b'[') => self.array(depth),
            Some(b'"') => self.string().map(Json::Str),
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ if self.eat("null") => Ok(Json::Null),
            _ if self.eat("true") => Ok(Json::Bool(true)),
            _ if self.eat("false") => Ok(Json::Bool(false)),
            _ => Err(self.err("expected a value")),
        }
    }

    fn object(&mut self, depth: usize) -> Result<Json, String> {
        self.i += 1;
        let mut members: Vec<(Vec<u16>, Json)> = Vec::new();
        let mut index: Option<HashMap<Vec<u16>, usize>> = None;
        self.ws();
        if self.eat("}") {
            return Ok(Json::Obj(members));
        }
        loop {
            self.ws();
            if self.s.get(self.i) != Some(&b'"') {
                return Err(self.err("expected a key"));
            }
            let key = self.string()?;
            self.ws();
            if !self.eat(":") {
                return Err(self.err("expected ':'"));
            }
            self.ws();
            let v = self.value(depth + 1)?;
            let at = match &index {
                Some(index) => index.get(&key).copied(),
                None => members.iter().position(|(k, _)| *k == key),
            };
            match at {
                Some(at) => members[at].1 = v,
                None => {
                    if let Some(index) = &mut index {
                        index.insert(key.clone(), members.len());
                    }
                    members.push((key, v));
                    if index.is_none() && members.len() >= INDEX_FROM {
                        let built = members.iter().enumerate().map(|(n, (k, _))| (k.clone(), n));
                        index = Some(built.collect());
                    }
                }
            }
            self.ws();
            if self.eat("}") {
                return Ok(Json::Obj(members));
            }
            if !self.eat(",") {
                return Err(self.err("expected ',' or '}'"));
            }
        }
    }

    fn array(&mut self, depth: usize) -> Result<Json, String> {
        self.i += 1;
        let mut items = Vec::new();
        self.ws();
        if self.eat("]") {
            return Ok(Json::Arr(items));
        }
        loop {
            self.ws();
            items.push(self.value(depth + 1)?);
            self.ws();
            if self.eat("]") {
                return Ok(Json::Arr(items));
            }
            if !self.eat(",") {
                return Err(self.err("expected ',' or ']'"));
            }
        }
    }

    fn string(&mut self) -> Result<Vec<u16>, String> {
        self.i += 1;
        let mut out = Vec::new();
        loop {
            let start = self.i;
            while let Some(&b) = self.s.get(self.i) {
                if b == b'"' || b == b'\\' || b < 0x20 {
                    break;
                }
                self.i += 1;
            }
            // `s` came from a `&str` and we stopped on ASCII, so the run is whole UTF-8.
            let run = std::str::from_utf8(&self.s[start..self.i]).map_err(|e| e.to_string())?;
            out.extend(run.encode_utf16());
            match self.s.get(self.i) {
                Some(b'"') => {
                    self.i += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.i += 1;
                    out.push(self.escape()?);
                }
                _ => return Err(self.err("unterminated string")),
            }
        }
    }

    fn escape(&mut self) -> Result<u16, String> {
        let c = self.s.get(self.i).copied();
        self.i += 1;
        Ok(match c {
            Some(b'"') => 0x22,
            Some(b'\\') => 0x5c,
            Some(b'/') => 0x2f,
            Some(b'b') => 0x08,
            Some(b'f') => 0x0c,
            Some(b'n') => 0x0a,
            Some(b'r') => 0x0d,
            Some(b't') => 0x09,
            Some(b'u') => {
                let hex = self
                    .s
                    .get(self.i..self.i + 4)
                    .ok_or_else(|| self.err("bad \\u escape"))?;
                let hex = std::str::from_utf8(hex).map_err(|_| self.err("bad \\u escape"))?;
                if !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return Err(self.err("bad \\u escape"));
                }
                self.i += 4;
                u16::from_str_radix(hex, 16).map_err(|_| self.err("bad \\u escape"))?
            }
            _ => return Err(self.err("bad escape")),
        })
    }

    fn number(&mut self) -> Result<Json, String> {
        let start = self.i;
        self.eat("-");
        match self.s.get(self.i) {
            Some(b'0') => self.i += 1,
            Some(b'1'..=b'9') => self.digits(),
            _ => return Err(self.err("bad number")),
        }
        if self.eat(".") {
            if !matches!(self.s.get(self.i), Some(b'0'..=b'9')) {
                return Err(self.err("bad number"));
            }
            self.digits();
        }
        if matches!(self.s.get(self.i), Some(b'e' | b'E')) {
            self.i += 1;
            if matches!(self.s.get(self.i), Some(b'+' | b'-')) {
                self.i += 1;
            }
            if !matches!(self.s.get(self.i), Some(b'0'..=b'9')) {
                return Err(self.err("bad number"));
            }
            self.digits();
        }
        let lexeme = std::str::from_utf8(&self.s[start..self.i]).map_err(|e| e.to_string())?;
        // Rust's parse rounds correctly, as JavaScript does, and overflows to infinity.
        lexeme
            .parse::<f64>()
            .map(Json::Num)
            .map_err(|e| e.to_string())
    }

    fn digits(&mut self) {
        while matches!(self.s.get(self.i), Some(b'0'..=b'9')) {
            self.i += 1;
        }
    }
}

/// `asciiJson(JSON.stringify(value, null, 2))`.
pub fn stringify(v: &Json) -> String {
    let mut out = String::new();
    write_value(v, 0, &mut out);
    out
}

fn write_value(v: &Json, depth: usize, out: &mut String) {
    match v {
        Json::Null => out.push_str("null"),
        Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Json::Num(n) => out.push_str(&js_number(*n)),
        Json::Str(s) => write_string(s, out),
        Json::Arr(items) if items.is_empty() => out.push_str("[]"),
        Json::Arr(items) => {
            out.push('[');
            for (n, item) in items.iter().enumerate() {
                out.push_str(if n == 0 { "\n" } else { ",\n" });
                indent(depth + 1, out);
                write_value(item, depth + 1, out);
            }
            out.push('\n');
            indent(depth, out);
            out.push(']');
        }
        Json::Obj(members) if members.is_empty() => out.push_str("{}"),
        Json::Obj(members) => {
            out.push('{');
            for (n, (k, val)) in js_key_order(members).into_iter().enumerate() {
                out.push_str(if n == 0 { "\n" } else { ",\n" });
                indent(depth + 1, out);
                write_string(k, out);
                out.push_str(": ");
                write_value(val, depth + 1, out);
            }
            out.push('\n');
            indent(depth, out);
            out.push('}');
        }
    }
}

fn indent(depth: usize, out: &mut String) {
    for _ in 0..depth {
        out.push_str("  ");
    }
}

/// Own-property order: array-index keys ascending, then the rest in insertion order.
fn js_key_order(members: &[(Vec<u16>, Json)]) -> Vec<&(Vec<u16>, Json)> {
    let mut index: Vec<(u32, &(Vec<u16>, Json))> = Vec::new();
    let mut rest = Vec::new();
    for m in members {
        match array_index(&m.0) {
            Some(n) => index.push((n, m)),
            None => rest.push(m),
        }
    }
    index.sort_by_key(|(n, _)| *n);
    index.into_iter().map(|(_, m)| m).chain(rest).collect()
}

/// A canonical decimal integer from 0 to 2^32 - 2, the range JavaScript treats as an index.
fn array_index(key: &[u16]) -> Option<u32> {
    if key.is_empty() || key.len() > 10 || (key.len() > 1 && key[0] == u16::from(b'0')) {
        return None;
    }
    let mut n: u64 = 0;
    for &u in key {
        if !(u16::from(b'0')..=u16::from(b'9')).contains(&u) {
            return None;
        }
        n = n * 10 + u64::from(u - u16::from(b'0'));
    }
    u32::try_from(n).ok().filter(|&n| n != u32::MAX)
}

fn write_string(s: &[u16], out: &mut String) {
    out.push('"');
    for &u in s {
        match u {
            0x22 => out.push_str("\\\""),
            0x5c => out.push_str("\\\\"),
            0x08 => out.push_str("\\b"),
            0x0c => out.push_str("\\f"),
            0x0a => out.push_str("\\n"),
            0x0d => out.push_str("\\r"),
            0x09 => out.push_str("\\t"),
            // Controls by JSON.stringify; U+007F and up (surrogates included) by asciiJson.
            0x00..=0x1f | 0x7f.. => {
                let _ = write!(out, "\\u{u:04x}");
            }
            _ => out.push(char::from(u as u8)),
        }
    }
    out.push('"');
}

/// JavaScript's `Number.prototype.toString()` for a value `JSON.stringify` prints.
pub fn js_number(v: f64) -> String {
    if !v.is_finite() {
        return "null".into();
    }
    if v == 0.0 {
        return "0".into();
    }
    // Rust's `{:e}` breaks a tie between 2 shortest digit strings upwards; ECMAScript
    // picks the even one (-859538942790036.25 prints as ...036.2). ryu-js follows ECMAScript.
    ryu_js::Buffer::new().format_finite(v).to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_print_as_javascript_does() {
        let cases = [
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (-1.5, "-1.5"),
            (100.0, "100"),
            (0.1, "0.1"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (123_456_789_012_345_680_000.0, "123456789012345680000"),
            (1.5e-7, "1.5e-7"),
            (0.000_001, "0.000001"),
            (5e-324, "5e-324"),
            (1.797_693_134_862_315_7e308, "1.7976931348623157e+308"),
            // Both literals parse to a double ending in .25, a tie between .2 and .3.
            (-859_538_942_790_036.2, "-859538942790036.2"),
            (1_030_019_659_035_116.2, "1030019659035116.2"),
            (1.23e-18, "1.23e-18"),
            (9_007_199_254_740_994.0, "9007199254740994"),
            (f64::INFINITY, "null"),
        ];
        assert_eq!(-859_538_942_790_036.2_f64.fract(), -0.25);
        for (v, want) in cases {
            assert_eq!(js_number(v), want, "{v:e}");
        }
    }

    #[test]
    fn strings_escape_as_ascii_json_does() {
        let v = Json::Str(vec![
            0x22, 0x5c, 0x2f, 0x0a, 0x01, 0x7f, 0xe9, 0x2028, 0xd83d, 0xde00, 0xdc00,
        ]);
        assert_eq!(
            stringify(&v),
            r#""\"\\/\n\u0001\u007f\u00e9\u2028\ud83d\ude00\udc00""#
        );
    }

    #[test]
    fn repeated_key_keeps_first_place_and_last_value() {
        let v = parse(r#"{"a":1,"b":2,"a":3}"#).unwrap();
        assert_eq!(stringify(&v), "{\n  \"a\": 3,\n  \"b\": 2\n}");
    }

    #[test]
    fn index_keys_print_first_in_numeric_order() {
        let v = parse(r#"{"b":1,"10":2,"2":3,"01":4,"4294967295":5,"4294967294":6}"#).unwrap();
        let keys: Vec<String> = match &v {
            Json::Obj(m) => js_key_order(m)
                .iter()
                .map(|(k, _)| String::from_utf16_lossy(k))
                .collect(),
            _ => unreachable!(),
        };
        assert_eq!(keys, ["2", "10", "4294967294", "b", "01", "4294967295"]);
    }

    #[test]
    fn lone_surrogate_escapes_round_trip() {
        let v = parse(r#""\uD800x""#).unwrap();
        assert_eq!(v, Json::Str(vec![0xd800, 0x78]));
        assert_eq!(stringify(&v), r#""\ud800x""#);
    }

    #[test]
    fn rejects_what_json_parse_rejects() {
        for bad in [
            "",
            "01",
            "1.",
            "[1,]",
            "{\"a\":1,}",
            "'a'",
            "\"\t\"",
            "\u{feff}{}",
            "[1] 2",
            "-",
            "1e",
            "\"\\x\"",
        ] {
            assert!(parse(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn repeated_keys_in_a_large_object_use_the_index() {
        let keys: String = (0..40).map(|n| format!("\"k{n}\":{n},")).collect();
        let v = parse(&format!("{{{keys}\"k3\":true,\"k39\":null,\"z\":0}}")).unwrap();
        let Json::Obj(m) = &v else { unreachable!() };
        assert_eq!(m.len(), 41);
        assert_eq!(m[3], (utf16("k3"), Json::Bool(true)));
        assert_eq!(m[39], (utf16("k39"), Json::Null));
        assert_eq!(m[40].0, utf16("z"));
    }

    #[test]
    fn nesting_stops_past_the_cap() {
        let deep = |d: usize| format!("{}{}", "[".repeat(d), "]".repeat(d));
        let ok = std::thread::Builder::new()
            .stack_size(STACK_BYTES)
            .spawn(move || {
                (
                    parse(&deep(MAX_DEPTH + 1)).is_ok(),
                    parse(&deep(MAX_DEPTH + 2)).is_err(),
                )
            })
            .unwrap()
            .join()
            .unwrap();
        assert_eq!(ok, (true, true));
    }

    #[test]
    fn empty_containers_stay_on_one_line() {
        let v = parse(r#"{"a":[],"b":{},"c":[[]]}"#).unwrap();
        assert_eq!(
            stringify(&v),
            "{\n  \"a\": [],\n  \"b\": {},\n  \"c\": [\n    []\n  ]\n}"
        );
    }
}
