#!/usr/bin/env bash
# gg-bench ask (the ask branch's runner) on semble's 1,251 questions, measuring the semantic branch's build in wt.
# MODE=on (default ranking) or MODE=off (TRAIL_SEMANTIC=0). A job stopped at the 30-minute limit is retried
# and goes on from the repositories it already answered.
set -u
W=<path>
MODE=${MODE:-on}
export CARGO_INCREMENTAL=0 TMPDIR=$W/tmp CARGO_TARGET_DIR=$W/target/gg-bench npm_config_cache=$W/npm-cache
mkdir -p "$TMPDIR" "$W/out/ask-$MODE"
[ "$MODE" = off ] && export TRAIL_SEMANTIC=0
T=$W/wt-bench; A=$W/askwork-$MODE; G=$W/wt
W6=<bench>
[ -d "$T" ] || git -C "$W/src/GrievousGreps" worktree add -q --detach "$T" origin/ryan/ask-benchmark-2026-11-19 || exit 92
echo "runner $(git -C "$T" rev-parse --short HEAD); tool $(node "$G/dist/bin/graft.js" --version | tail -1); mode $MODE"
[ -f "$G/built-$MODE" ] || { (cd "$G" && npm run build > "$W/out/ask-$MODE/build.txt" 2>&1) || exit 93; touch "$G/built-$MODE"; }
cd "$T/rust/gg-bench" && cargo build --locked --release -q || exit 95
B=$CARGO_TARGET_DIR/release/gg-bench
mkdir -p "$A/repos"
for d in "$W6"/work/repos/*/; do n=$(basename "$d"); [ -e "$A/repos/$n" ] || { cp -al "$d" "$A/repos/$n"; rm -f "$A/repos/$n/.checked-out"; }; done
echo "kept before this attempt: $(ls "$A/answers" 2>/dev/null | wc -l) repositories"
echo "=== ask $(date -u +%FT%TZ) load $(cut -d' ' -f1-3 /proc/loadavg)"
nice "$B" ask --tool "$G/dist/bin/graft.js" --work "$A" > "$W/out/ask-$MODE/report.md" 2> "$W/out/ask-$MODE/stderr.txt"
echo "ask exit $? $(date -u +%FT%TZ)"
head -30 "$W/out/ask-$MODE/report.md"; tail -5 "$W/out/ask-$MODE/stderr.txt"
rm -rf "$W/out/ask-$MODE/answers"; cp -a "$A/answers" "$W/out/ask-$MODE/answers"
echo "DONE $(date -u +%FT%TZ)"
