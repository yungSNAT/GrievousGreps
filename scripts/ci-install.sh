#!/usr/bin/env bash
# CI's install: `npm ci`, tried up to 3 times. The native grammars build with node-gyp, which
# downloads Node's headers from nodejs.org; on Windows that download was cut off after its
# 200 response ('terminated', 'Completion callback never invoked') on 2 pushes to main in
# November 2026, and a rerun passed each time. `npm ci` starts from an empty node_modules, so a
# second try repeats the whole install. A failure that repeats 3 times fails the job.
set -u
for attempt in 1 2 3; do
  npm ci && exit 0 # NOSONAR: locked dependencies need native grammar and prepare lifecycle scripts.
  echo "::warning::npm ci failed on attempt $attempt of 3"
  [[ "$attempt" -lt 3 ]] && sleep 20
done
exit 1
