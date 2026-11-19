#!/usr/bin/env bash
# `gg-bench ask` (the branch that adds it, in its own worktree) on semble's 1,251 questions,
# measuring the build at main 57122b3; then an earlier Python scorer, not in this repository, on the
# same kept answers, as a cross-check. A job stopped at the machine's 30-minute limit is retried; the
# run grades the repositories it already asked from their kept answers and goes on with the rest.
# This run finished in its first attempt.
set -u
W=<path>
export CARGO_INCREMENTAL=0 TMPDIR=$W/tmp CARGO_TARGET_DIR=$W/target/wt-ask3
mkdir -p "$TMPDIR" "$W/out/ask"
W6=<bench>
T=$W/wt-ask3; G=$W/gg-57122b3; A=$W/askwork
[ -f "$G/built" ] || { echo "no build at $G"; exit 91; }
[ -d "$T" ] || git -C "$W/src/GrievousGreps" worktree add -q --detach "$T" 57122b3 || exit 92
cd "$T" && git reset -q --hard 57122b3 && git clean -qfd && tar -xf "$W/jobs/ask3-src.tar" || exit 93
cd rust/gg-bench || exit 94
echo "ask tree: $(git -C "$T" rev-parse --short HEAD) plus the ask branch's files; tool $(node "$G/dist/bin/graft.js" --version | tail -1)"
cargo build --locked --release -q || exit 95
B=$CARGO_TARGET_DIR/release/gg-bench
mkdir -p "$A/repos"
# The checkouts semble pins, already fetched for an earlier run; gg-bench checks each one's HEAD.
for d in "$W6"/work/repos/*/; do n=$(basename "$d"); [ -e "$A/repos/$n" ] || { cp -a "$d" "$A/repos/$n"; rm -f "$A/repos/$n/.checked-out"; }; done
echo "kept before this attempt: $(ls "$A/answers" 2>/dev/null | wc -l) repositories"
echo "=== ask $(date -u +%FT%TZ) load $(cut -d' ' -f1-3 /proc/loadavg)"
nice "$B" ask --tool "$G/dist/bin/graft.js" --work "$A" > "$W/out/ask/report.md" 2> "$W/out/ask/stderr.txt"
echo "ask exit $? $(date -u +%FT%TZ)"
head -40 "$W/out/ask/report.md"; tail -5 "$W/out/ask/stderr.txt"
echo "=== the earlier scorer on the same answers"
python3 -I "$W/jobs/ask_equiv.py" "$T/benchmark/ask/semble" "$A" > "$W/out/ask/equiv.md"
diff <(sed -n '/^| All /,/^$/p' "$W/out/ask/report.md" | grep '^|') "$W/out/ask/equiv.md" && echo "TABLES MATCH"
rm -rf "$W/out/ask/answers"; cp -a "$A/answers" "$W/out/ask/answers"
echo "DONE $(date -u +%FT%TZ)"
