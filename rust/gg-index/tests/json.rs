//! Unit and contract tests for `gg_index::json` (JavaScript JSON semantics).

use gg_index::json::{
    Json, MAX_DEPTH, STACK_BYTES, js_number, parse, stringify, stringify_compact, utf16,
    write_compact_ascii, write_str_ascii,
};

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
    assert_eq!(
        stringify_compact(&v),
        r#"{"2":3,"10":2,"4294967294":6,"b":1,"01":4,"4294967295":5}"#
    );
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

#[test]
fn compact_utf8_and_ascii_match_javascript_stringify() {
    let v = Json::Obj(vec![
        (utf16("n"), Json::Null),
        (
            utf16("b"),
            Json::Arr(vec![Json::Bool(true), Json::Bool(false)]),
        ),
        (utf16("x"), Json::Num(1.5)),
        (
            utf16("s"),
            Json::Str(vec![
                0x22, 0x5c, 0x08, 0x0c, 0x0a, 0x0d, 0x09, 0x01, 0x7f, 0x00fc, 0x65e5, 0xd83d,
                0xde00, 0xd800, 0x78, 0xdc00, 0xd800,
            ]),
        ),
        (utf16("empty"), Json::Obj(vec![])),
    ]);
    assert_eq!(
        stringify_compact(&v),
        "{\"n\":null,\"b\":[true,false],\"x\":1.5,\"s\":\"\\\"\\\\\\b\\f\\n\\r\\t\\u0001\u{7f}ü日😀\\ud800x\\udc00\\ud800\",\"empty\":{}}"
    );
    let mut asc = String::new();
    write_compact_ascii(&v, &mut asc);
    assert_eq!(
        asc,
        "{\"n\":null,\"b\":[true,false],\"x\":1.5,\"s\":\"\\\"\\\\\\b\\f\\n\\r\\t\\u0001\\u007f\\u00fc\\u65e5\\ud83d\\ude00\\ud800x\\udc00\\ud800\",\"empty\":{}}"
    );
    let mut key_asc = String::new();
    write_str_ascii(&utf16("ü"), &mut key_asc);
    assert_eq!(key_asc, "\"\\u00fc\"");
}
