#!/usr/bin/env bash
# node 통계: jspi·nojspi 두 모드를 순서대로 돌린다(동시 실행 금지 — CPU 경합이 지연을 부풀린다).
# 출처 RD-009, `_works/_completed/20260922-09-rd-009-idle-ctrl-c/verify/node/`에서 이관(RD-018 DELTA-04).
# 실행: bash apps/demo/e2e/node/rd-009/run-n30.sh (아무 디렉터리에서나 가능, 경로는 스크립트 자신 기준)
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/../../../../.." && pwd)"

H1="$ROOT/packages/pyodide-testkit/src/ts-resolve-hook.mjs"
H2="$DIR/py-raw-hook.mjs"
SCRIPT="$DIR/sleep-stats.mjs"

N="${N:-30}"
PRESS="${PRESS:-300,3000}"

echo "== jspi (N=$N) =="
node --import "$H1" --import "$H2" "$SCRIPT" --mode jspi --n "$N" --press "$PRESS"

echo "== nojspi (N=$N) =="
node --import "$H1" --import "$H2" "$SCRIPT" --mode nojspi --n "$N" --press "$PRESS"
