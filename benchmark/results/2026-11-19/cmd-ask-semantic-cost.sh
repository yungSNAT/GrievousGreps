#!/usr/bin/env bash
# First-run cost of the semantic layer: a cold `trail build` of each of semble's 63 checkouts with
# TRAIL_SEMANTIC=0 and then with it on, the vectors sidecar's size, and `trail ask` time on 3 of them.
set -u
W=<path>
export TMPDIR=$W/tmp HOME=$W/home-cost TRAIL_HOME=$W/home-cost/.trail; mkdir -p $TMPDIR $TRAIL_HOME
[ -f $W/wt/built-cost ] || { (cd $W/wt && npm run build > /dev/null 2>&1) || exit 93; touch $W/wt/built-cost; }
G=$W/wt/dist/bin/graft.js; C=$W/costwork; O=$W/out/cost; mkdir -p $C $O
W6=<bench>/work/repos
echo "tool $(node $G --version | tail -1); $(date -u +%FT%TZ) load $(cut -d' ' -f1-3 /proc/loadavg)"
[ -f $O/builds.tsv ] || echo -e "repo\toff_s\ton_s\tvectors_bytes\tgraph_bytes" > $O/builds.tsv
for d in $W6/*/; do
  n=$(basename $d); grep -q "^$n	" $O/builds.tsv && continue
  [ -e $C/$n ] || cp -al $d $C/$n
  root=$C/$n; b=$(python3 -c "import json;print(next((r.get('benchmark_root') or '') for r in json.load(open('$W/jobs/semble-set/repos.json')) if r['name']=='$n'))"); [ -n "$b" ] && root=$C/$n/$b
  rm -rf $root/graft
  t0=$(date +%s.%N); TRAIL_SEMANTIC=0 node $G build $root --no-gitignore --no-ignore > /dev/null 2>&1; t1=$(date +%s.%N)
  rm -rf $root/graft
  node $G build $root --no-gitignore --no-ignore > /dev/null 2>&1; t2=$(date +%s.%N)
  vb=$(stat -c %s $root/graft/.cache/ask-vectors.bin 2>/dev/null || echo 0); gb=$(du -sb $root/graft | cut -f1)
  echo -e "$n\t$(awk "BEGIN{print $t1-$t0}")\t$(awk "BEGIN{print $t2-$t1}")\t$vb\t$gb" >> $O/builds.tsv
done
echo "=== ask timing $(date -u +%FT%TZ)"
for n in zig-clap flask zig; do
  # Ask where the build indexed: semble's benchmark root (lib/std for zig, src/flask for flask).
  root=$C/$n; b=$(python3 -c "import json;print(next((r.get('benchmark_root') or '') for r in json.load(open('$W/jobs/semble-set/repos.json')) if r['name']=='$n'))"); [ -n "$b" ] && root=$C/$n/$b
  for mode in 0 1; do
    for q in "how are command line arguments parsed" "error handling" "memory allocation strategy" "where is the configuration loaded" "tokenizer"; do
      t0=$(date +%s.%N); TRAIL_SEMANTIC=$mode node $G ask "$q" $root --json -n 10 > /dev/null 2>&1; t1=$(date +%s.%N)
      echo -e "$n\t$mode\t$(awk "BEGIN{print $t1-$t0}")"
    done
  done
done > $O/ask-times.tsv
python3 - $O/builds.tsv $O/ask-times.tsv <<'PY'
import csv, statistics, sys
rows = list(csv.DictReader(open(sys.argv[1]), delimiter="\t"))
off = sum(float(r["off_s"]) for r in rows); on = sum(float(r["on_s"]) for r in rows)
vb = sum(int(r["vectors_bytes"]) for r in rows)
print(f"{len(rows)} repos: build off {off:.1f}s, on {on:.1f}s (+{on-off:.1f}s, {100*(on-off)/off:.0f}%); vectors {vb/1e6:.1f} MB total, largest {max(int(r['vectors_bytes']) for r in rows)/1e6:.1f} MB")
t = {}
for n, m, s in csv.reader(open(sys.argv[2]), delimiter="\t"):
    t.setdefault((n, m), []).append(float(s))
for (n, m), v in sorted(t.items()):
    print(f"ask {n} TRAIL_SEMANTIC={m}: median {statistics.median(v):.2f}s of {len(v)}")
PY
echo "DONE $(date -u +%FT%TZ)"
