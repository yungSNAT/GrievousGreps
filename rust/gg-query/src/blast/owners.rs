//! Code-owner & reviewer inference from git history (`src/blast/owners.ts`).

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::blast::BlastReport;
use crate::blast::diff::git_run;
use crate::graph::{js_locale_cmp, serialize_js_f64};

const HALF_LIFE_MS: f64 = 120.0 * 24.0 * 60.0 * 60.0 * 1000.0;
const SINCE: &str = "36.months";
const MAX_COMMITS: usize = 400;
const MAX_PATHSPEC: usize = 80;
const MIN_SHARE: f64 = 0.15;
const MAX_PER_AREA: usize = 2;
pub(crate) const MAX_REVIEWERS: usize = 3;
const AFFECTED_WEIGHT: f64 = 0.6;

#[derive(Debug, Clone, Serialize)]
pub struct Owner {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handle: Option<String>,
    pub commits: usize,
    #[serde(serialize_with = "serialize_js_f64")]
    pub score: f64,
    #[serde(serialize_with = "serialize_js_f64")]
    pub last: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Reviewer {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handle: Option<String>,
    pub commits: usize,
    #[serde(serialize_with = "serialize_js_f64")]
    pub score: f64,
    #[serde(serialize_with = "serialize_js_f64")]
    pub last: f64,
    pub areas: Vec<String>,
}

pub fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |d| {
            (d.as_secs() as f64) * 1000.0 + (d.subsec_millis() as f64)
        })
}

fn is_valid_github_username(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.is_empty() || bytes.len() > 39 {
        return false;
    }
    if !bytes[0].is_ascii_alphanumeric() {
        return false;
    }
    let mut prev_hyphen = false;
    for &b in bytes {
        if b == b'-' {
            if prev_hyphen {
                return false;
            }
            prev_hyphen = true;
        } else if b.is_ascii_alphanumeric() {
            prev_hyphen = false;
        } else {
            return false;
        }
    }
    !prev_hyphen
}

pub fn github_handle(email: &str) -> Option<String> {
    let trimmed = email.trim();
    let lower = trimmed.to_ascii_lowercase();
    let local = lower.strip_suffix("@users.noreply.github.com")?;
    let raw_local = &trimmed[..local.len()];
    let candidate = match raw_local.split_once('+') {
        Some((digits, user))
            if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) =>
        {
            user
        }
        Some(_) => return None,
        None => raw_local,
    };
    is_valid_github_username(candidate).then(|| candidate.to_string())
}

fn is_bot(name: &str, email: &str) -> bool {
    let nl = name.to_ascii_lowercase();
    let el = email.to_ascii_lowercase();
    if nl.contains("[bot]") || el.contains("[bot]@") {
        return true;
    }
    let trimmed = nl.trim();
    matches!(
        trimmed.strip_suffix("[bot]").unwrap_or(trimmed),
        "github-actions" | "dependabot" | "renovate"
    )
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = y - if m <= 2 { 1 } else { 0 };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Parse ISO-8601 `%aI` timestamps (`YYYY-MM-DDTHH:MM:SS(.sss)?(Z|+HH:MM|-HH:MM)`).
pub fn parse_iso_ms(raw: &str) -> Option<f64> {
    let s = raw.trim();
    if s.len() < 19 {
        return None;
    }
    let b = s.as_bytes();
    if b[4] != b'-'
        || b[7] != b'-'
        || !matches!(b[10], b'T' | b't' | b' ')
        || b[13] != b':'
        || b[16] != b':'
    {
        return None;
    }
    let y: i64 = s[0..4].parse().ok()?;
    let mo: i64 = s[5..7].parse().ok()?;
    let d: i64 = s[8..10].parse().ok()?;
    let hh: i64 = s[11..13].parse().ok()?;
    let mm: i64 = s[14..16].parse().ok()?;
    let ss: i64 = s[17..19].parse().ok()?;
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || hh > 23 || mm > 59 || ss > 60 {
        return None;
    }
    let mut idx = 19;
    let mut millis = 0_i64;
    if b.get(idx) == Some(&b'.') {
        idx += 1;
        let frac_start = idx;
        while b.get(idx).is_some_and(u8::is_ascii_digit) {
            idx += 1;
        }
        let frac = &s[frac_start..idx];
        let mut padded = [b'0'; 3];
        for (slot, ch) in padded.iter_mut().zip(frac.bytes().take(3)) {
            *slot = ch;
        }
        millis = std::str::from_utf8(&padded).ok()?.parse().ok()?;
    }
    let mut offset_secs = 0_i64;
    if let Some(tz) = s.get(idx..)
        && !tz.is_empty()
        && !tz.eq_ignore_ascii_case("z")
    {
        let sign = match tz.as_bytes().first() {
            Some(b'+') => 1,
            Some(b'-') => -1,
            _ => return None,
        };
        let rest = &tz[1..];
        let (tzh, tzm) = if let Some((h, m)) = rest.split_once(':') {
            (h, m)
        } else if rest.len() == 4 {
            (&rest[0..2], &rest[2..4])
        } else {
            return None;
        };
        let th: i64 = tzh.parse().ok()?;
        let tm: i64 = tzm.parse().ok()?;
        offset_secs = sign * (th * 3600 + tm * 60);
    }
    let days = days_from_civil(y, mo, d);
    let secs = days * 86_400 + hh * 3_600 + mm * 60 + ss - offset_secs;
    Some((secs as f64) * 1000.0 + (millis as f64))
}

struct PersonAcc {
    owner: Owner,
    seen: HashSet<String>,
}

pub fn owners_for(root: &Path, files: &[String], exclude: &[String], now: f64) -> Vec<Owner> {
    let mut paths = files.to_vec();
    paths.sort();
    paths.truncate(MAX_PATHSPEC);
    if paths.is_empty() {
        return Vec::new();
    }

    let since_flag = format!("--since={SINCE}");
    let max_str = MAX_COMMITS.to_string();
    let mut args: Vec<&str> = vec![
        "log",
        "--no-merges",
        &since_flag,
        "-n",
        &max_str,
        "--format=\x01%H\x02%aI\x02%aN\x02%aE",
        "--name-only",
        "--",
    ];
    for p in &paths {
        args.push(p.as_str());
    }
    let Some(raw) = git_run(root, &args) else {
        return Vec::new();
    };
    let out = String::from_utf8_lossy(&raw);
    let wanted: HashSet<&str> = paths.iter().map(String::as_str).collect();
    let mut people: HashMap<String, PersonAcc> = HashMap::new();
    let mut cur_commit: Option<(String, f64, f64, String, String)> = None;

    for line in out.split('\n') {
        if let Some(hdr) = line.strip_prefix('\x01') {
            let mut parts = hdr.split('\x02');
            let hash = parts.next().unwrap_or("").to_string();
            let iso = parts.next().unwrap_or("");
            let name = parts.next().unwrap_or("").to_string();
            let email = parts.next().unwrap_or("").to_string();
            cur_commit = parse_iso_ms(iso).map(|at| {
                let weight = 0.5_f64.powf((now - at) / HALF_LIFE_MS);
                (hash, at, weight, name, email)
            });
            continue;
        }
        let Some((ref hash, at, weight, ref name, ref email)) = cur_commit else {
            continue;
        };
        let clean = line.trim_end_matches('\r');
        if !wanted.contains(clean) || is_bot(name, email) {
            continue;
        }
        let handle = github_handle(email);
        let key = handle
            .as_deref()
            .unwrap_or(email.as_str())
            .to_ascii_lowercase();
        let entry = people.entry(key).or_insert_with(|| PersonAcc {
            owner: Owner {
                name: name.clone(),
                handle: handle.clone(),
                commits: 0,
                score: 0.0,
                last: at,
            },
            seen: HashSet::new(),
        });
        if entry.seen.insert(hash.clone()) {
            entry.owner.commits += 1;
            entry.owner.score += weight;
            if at > entry.owner.last {
                entry.owner.last = at;
            }
        }
    }

    let excluded: HashSet<String> = exclude
        .iter()
        .map(|e| e.trim().to_ascii_lowercase())
        .filter(|e| !e.is_empty())
        .collect();
    let mut kept: Vec<Owner> = people
        .into_iter()
        .filter(|(email_key, acc)| {
            !excluded.contains(email_key)
                && !excluded.contains(&acc.owner.name.to_ascii_lowercase())
                && acc
                    .owner
                    .handle
                    .as_ref()
                    .is_none_or(|h| !excluded.contains(&h.to_ascii_lowercase()))
        })
        .map(|(_, acc)| acc.owner)
        .collect();

    let total: f64 = kept.iter().map(|o| o.score).sum();
    kept.retain(|o| total == 0.0 || (o.score / total) >= MIN_SHARE);
    kept.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.commits.cmp(&a.commits))
            .then_with(|| js_locale_cmp(&a.name, &b.name))
    });
    kept.truncate(MAX_PER_AREA);
    kept
}

pub fn diff_authors(root: &Path, base: &str) -> Vec<String> {
    let range = format!("{base}...HEAD");
    let Some(raw) = git_run(
        root,
        &[
            "log",
            "--format=%aN%n%aE%n%(trailers:key=Co-authored-by,valueonly)",
            &range,
        ],
    ) else {
        return Vec::new();
    };
    let out = String::from_utf8_lossy(&raw);
    let mut names = HashSet::new();
    let mut ordered = Vec::new();
    for raw_line in out.split('\n') {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(without_gt) = line.strip_suffix('>')
            && let Some(open) = without_gt.rfind('>').map_or_else(
                || without_gt.find('<'),
                |prev| without_gt[prev + 1..].find('<').map(|rel| prev + 1 + rel),
            )
        {
            let name = without_gt[..open].trim_end();
            let email = &without_gt[open + 1..];
            if !email.is_empty() && !name.contains(['\r', '\u{2028}', '\u{2029}']) {
                if !name.is_empty() && names.insert(name.to_string()) {
                    ordered.push(name.to_string());
                }
                if names.insert(email.to_string()) {
                    ordered.push(email.to_string());
                }
                continue;
            }
        }
        if names.insert(line.to_string()) {
            ordered.push(line.to_string());
        }
    }
    ordered
}

pub fn local_identity(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    for key in ["user.name", "user.email"] {
        if let Some(raw) = git_run(root, &["config", key]) {
            let trimmed = String::from_utf8_lossy(&raw).trim().to_string();
            if !trimmed.is_empty() {
                out.push(trimmed);
            }
        }
    }
    out
}

pub fn attach_owners(root: &Path, report: &mut BlastReport, exclude: &[String], now: f64) {
    struct RankedAcc {
        reviewer: Reviewer,
        weighted: f64,
    }
    let mut ranked: HashMap<String, RankedAcc> = HashMap::new();

    let mut visit = |label: &str, files: &[String], weight: f64| -> Vec<Owner> {
        let owners = owners_for(root, files, exclude, now);
        for o in &owners {
            let key = o
                .handle
                .as_deref()
                .unwrap_or(o.name.as_str())
                .to_ascii_lowercase();
            let entry = ranked.entry(key).or_insert_with(|| RankedAcc {
                reviewer: Reviewer {
                    name: o.name.clone(),
                    handle: o.handle.clone(),
                    commits: 0,
                    score: 0.0,
                    last: o.last,
                    areas: Vec::new(),
                },
                weighted: 0.0,
            });
            entry.reviewer.areas.push(label.to_string());
            entry.reviewer.commits += o.commits;
            entry.reviewer.score += o.score;
            entry.weighted += o.score * weight;
            if o.last > entry.reviewer.last {
                entry.reviewer.last = o.last;
            }
            if entry.reviewer.handle.is_none() && o.handle.is_some() {
                entry.reviewer.handle = o.handle.clone();
            }
        }
        owners
    };

    for area in &mut report.areas {
        area.owners = Some(visit(&area.label, &area.files, 1.0));
    }
    for m in &mut report.modules {
        m.owners = Some(visit(&m.label, &m.files, AFFECTED_WEIGHT));
    }

    let mut items: Vec<RankedAcc> = ranked.into_values().collect();
    items.sort_by(|a, b| {
        b.weighted
            .partial_cmp(&a.weighted)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.reviewer.commits.cmp(&a.reviewer.commits))
            .then_with(|| js_locale_cmp(&a.reviewer.name, &b.reviewer.name))
    });
    items.truncate(MAX_REVIEWERS);
    report.reviewers = Some(items.into_iter().map(|i| i.reviewer).collect());
}

pub fn since_label(last: f64, now: f64) -> String {
    let days = ((now - last) / (24.0 * 60.0 * 60.0 * 1000.0))
        .round()
        .max(0.0) as u64;
    if days < 1 {
        return "today".to_string();
    }
    if days == 1 {
        return "yesterday".to_string();
    }
    if days < 31 {
        return format!("{days}d ago");
    }
    let months = ((days as f64) / 30.0).round() as u64;
    if months < 24 {
        format!("{months}mo ago")
    } else {
        format!("{}y ago", ((days as f64) / 365.0).round() as u64)
    }
}

pub fn mention(o: &Owner) -> String {
    match &o.handle {
        Some(h) => format!("@{h}"),
        None => o.name.clone(),
    }
}
