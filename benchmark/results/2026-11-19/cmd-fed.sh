#!/usr/bin/env bash
# R3645: the 3 figures #93 dropped, rerun at the job's commit with output kept:
# httpx `trail viz --export` (code nodes, bytes), a click + flask + httpx folder's `trail build` time,
# and `trail ask` from that folder (hits from several repositories in one ranking).
set -u
W=<path>
B=<bench>
export CARGO_INCREMENTAL=0 npm_config_cache=$W/npm-cache TMPDIR=$W/tmp
mkdir -p "$TMPDIR"
SHA=$(git rev-parse --short HEAD); SRC=$PWD
G=$W/gg-$SHA
if [ ! -f "$G/built" ]; then
  [ -d "$G" ] || git -C "$SRC" worktree add -q --detach "$G" "$SHA" || exit 92
  (cd "$G" && nice npm ci --no-audit --no-fund > "$W/npm-ci-$SHA.log" 2>&1 && nice npm run build > "$W/build-$SHA.log" 2>&1) || { tail -20 "$W/build-$SHA.log"; exit 93; }
  touch "$G/built"
fi
S=$W/fed; rm -rf "$S"; mkdir -p "$S/home" "$S/bin" "$S/work"
printf '#!/bin/sh\nexec node %s/dist/bin/trail.js "$@"\n' "$G" > "$S/bin/trail"; chmod +x "$S/bin/trail"
export HOME=$S/home USERPROFILE=$S/home PATH=$S/bin:/usr/bin:/bin DO_NOT_TRACK=1
echo "pinned $(git -C "$G" rev-parse HEAD) $(date -u +%FT%TZ) node $(node --version) trail $(trail --version | tail -1)"
for r in click flask httpx; do echo "checkout $r $(git -C "$B/repos/$r" rev-parse HEAD) dirty=$(git -C "$B/repos/$r" status --porcelain | wc -l)"; done

echo "##### viz --export on httpx"
cp -a "$B/repos/httpx" "$S/work/httpx" && cd "$S/work/httpx" || exit 94
trail init --yes > "$S/init.txt" 2>&1; echo "init exit $?"; tail -5 "$S/init.txt"
trail viz --export site/; echo "export exit $?"
echo "index.html bytes: $(wc -c < site/index.html)"
echo "external script/style refs: $(grep -ciE '<(script|link)[^>]+(src|href)="https?://' site/index.html)"

echo "##### multi-repository folder build, 3 fresh copies"
for i in 1 2 3; do
  M=$S/work/multi$i; mkdir -p "$M" && cd "$M" || exit 95
  for r in click flask httpx; do cp -a "$B/repos/$r" .; done
  echo "load before run $i: $(cut -d' ' -f1-3 /proc/loadavg)"
  t0=$(date +%s.%N); trail build > "$S/build$i.txt" 2>&1; code=$?; t1=$(date +%s.%N)
  echo "run $i: trail build exit $code, $(python3 -c "print(round($t1 - $t0, 2))") s"
  tail -4 "$S/build$i.txt"
done
cd "$S/work/multi1" || exit 96
echo "##### trail callers get_current_context from the folder"
trail callers get_current_context > "$S/callers.txt" 2>&1; echo "exit $?"
cat "$S/callers.txt"
echo "lines naming tests/test_cli.py: $(grep -c 'tests/test_cli.py' "$S/callers.txt")"
for q in "current context" "application context" "parse command line options" "send an HTTP request"; do
  echo "##### trail ask \"$q\" from the folder"
  trail ask "$q" > "$S/ask.txt" 2>&1; echo "exit $?"
  cat "$S/ask.txt"
  echo "--- json"
  trail ask "$q" --json -n 10 2>/dev/null | head -c 6000; echo
done
rm -rf "$S/work"
echo "DONE $(date -u +%FT%TZ)"
