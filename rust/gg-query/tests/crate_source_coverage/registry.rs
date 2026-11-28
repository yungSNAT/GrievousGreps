//! Registry URL validation, crates.io index matching and custom registry error tests.

use std::fs;

use gg_query::crate_source::ResolutionStatus;

use crate::{make_lock, status_of, write_file};

const CRATES_IO: &str = "registry+https://github.com/rust-lang/crates.io-index";
const PKG_TOML: &str = "[package]\nname = \"rpkg\"\nversion = \"1.0.0\"\n";

#[test]
fn rejects_invalid_registry_urls() {
    let tmp = tempfile::tempdir().unwrap();
    let ch = tmp.path().join("ch");
    fs::create_dir_all(&ch).unwrap();

    for (idx, bad_url) in [
        "registry+https://.evil.com/index",
        "registry+https://a..b.com/index",
        "registry+https://user@example.com/index",
        "registry+https:///index",
        "registry+https://[::1]bad/index",
        "registry+https://ex[ample.com/index",
        "registry+https://example.com:/index",
        "registry+https://example.com:abc/index",
        "registry+https://example.com:99999/index",
        "registry+https://example.com:0/index",
        "registry+ftp://example.com/index",
    ]
    .iter()
    .enumerate()
    {
        let r = tmp.path().join(format!("bad_{idx}"));
        write_file(
            &r.join("Cargo.lock"),
            make_lock("rpkg", "1.0.0", Some(bad_url)),
        );
        assert_eq!(
            status_of(&r, &ch, "rpkg"),
            ResolutionStatus::Unresolved,
            "{bad_url}"
        );
    }
}

#[test]
fn handles_missing_registry_src_and_crates_io_variants() {
    let tmp = tempfile::tempdir().unwrap();
    let ch_empty = tmp.path().join("ch_empty");
    fs::create_dir_all(&ch_empty).unwrap();

    let repo = tmp.path().join("repo");
    write_file(
        &repo.join("Cargo.lock"),
        make_lock("rpkg", "1.0.0", Some(CRATES_IO)),
    );
    assert_eq!(
        status_of(&repo, &ch_empty, "rpkg"),
        ResolutionStatus::NotCached
    );

    let ch = tmp.path().join("ch_cio");
    write_file(&ch.join("registry/src/.keep"), "");
    write_file(
        &ch.join("registry/src/index.crates.io-1/rpkg-1.0.0"),
        "not a dir",
    );
    write_file(
        &ch.join("registry/src/other.example.com-deadbeef/rpkg-1.0.0/Cargo.toml"),
        PKG_TOML,
    );
    assert_eq!(status_of(&repo, &ch, "rpkg"), ResolutionStatus::NotCached);

    write_file(
        &ch.join("registry/src/github.com-1ecc6299db9ec823/rpkg-1.0.0/Cargo.toml"),
        PKG_TOML,
    );
    assert_eq!(status_of(&repo, &ch, "rpkg"), ResolutionStatus::Found);
}

#[test]
fn normalises_custom_registry_ipv6_ports_and_pathless_urls() {
    let tmp = tempfile::tempdir().unwrap();
    for (tag, locked, origin) in [
        (
            "ipv6_port",
            "registry+https://[::1]:8443/index",
            "https://[0:0:0:0:0:0:0:1]:8443/index.git",
        ),
        (
            "https_443",
            "registry+https://example.com:443/index",
            "https://EXAMPLE.COM/index/",
        ),
        (
            "http_80",
            "registry+http://example.com:80/index",
            "http://example.com/index",
        ),
        (
            "pathless",
            "registry+https://example.com",
            "https://example.com/",
        ),
    ] {
        let r = tmp.path().join(format!("r_{tag}"));
        let ch = tmp.path().join(format!("ch_{tag}"));
        write_file(
            &r.join("Cargo.lock"),
            make_lock("rpkg", "1.0.0", Some(locked)),
        );
        write_file(
            &ch.join("registry/src/custom-1/rpkg-1.0.0/Cargo.toml"),
            PKG_TOML,
        );
        write_file(
            &ch.join("registry/index/custom-1/.git/config"),
            format!("[remote \"origin\"]\n\turl = {origin}\n"),
        );
        assert_eq!(status_of(&r, &ch, "rpkg"), ResolutionStatus::Found, "{tag}");
    }
}

#[test]
fn fails_closed_on_custom_index_config_and_workspace_errors() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("r_cust");
    let custom = "registry+https://pkgs.example.com/index";
    write_file(
        &repo.join("Cargo.lock"),
        make_lock("rpkg", "1.0.0", Some(custom)),
    );

    for (tag, cfg, expect) in [
        (
            "bad_origin",
            b"[remote \"origin\"]\n\turl = ftp://pkgs.example.com/index\n".to_vec(),
            ResolutionStatus::Unresolved,
        ),
        (
            "no_origin",
            b"[core]\n\tbare = true\n".to_vec(),
            ResolutionStatus::Unresolved,
        ),
        (
            "bad_utf8",
            vec![0xff, 0xfe, 0x80],
            ResolutionStatus::Unresolved,
        ),
        (
            "huge_cfg",
            vec![b'a'; 260 * 1024],
            ResolutionStatus::BudgetExhausted,
        ),
    ] {
        let ch = tmp.path().join(format!("ch_{tag}"));
        write_file(
            &ch.join("registry/src/custom-1/rpkg-1.0.0/Cargo.toml"),
            PKG_TOML,
        );
        write_file(&ch.join("registry/index/custom-1/.git/config"), cfg);
        assert_eq!(status_of(&repo, &ch, "rpkg"), expect, "{tag}");
    }
}

#[test]
fn fails_closed_on_registry_workspace_manifest_error() {
    let tmp = tempfile::tempdir().unwrap();
    let r_cio = tmp.path().join("r_cio");
    write_file(
        &r_cio.join("Cargo.lock"),
        make_lock("rpkg", "1.0.0", Some(CRATES_IO)),
    );
    let ch_ws = tmp.path().join("ch_ws");
    write_file(
        &ch_ws.join("registry/src/index.crates.io-1/Cargo.toml"),
        "[workspace]\nmembers = [\n",
    );
    write_file(
        &ch_ws.join("registry/src/index.crates.io-1/rpkg-1.0.0/Cargo.toml"),
        "[package]\nname = \"rpkg\"\nversion.workspace = true\n",
    );
    assert_eq!(
        status_of(&r_cio, &ch_ws, "rpkg"),
        ResolutionStatus::Unresolved
    );
}
