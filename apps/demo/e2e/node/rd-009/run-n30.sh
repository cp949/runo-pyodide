#!/usr/bin/env bash
# RD-009 node 통계. `sleep-stats.mjs`를 `jspi`·`nojspi` 두 모드로 순서대로 돌린다.
# 출처 RD-009에서 이관(RD-018). 실행법·판정선은 rd-009/README.md다.
#
# 순서:
# 1. jspi.
# 2. nojspi.
# 동시에 돌리지 않는다. CPU 경합이 지연을 부풀린다.
#
# 실행: bash apps/demo/e2e/node/rd-009/run-n30.sh (아무 디렉터리에서나 가능하다. 경로는 스크립트 자신 기준이다.)
# 환경변수: `N`(모드당 시행 수, 기본 30), `PRESS`(눌림 시각 범위 ms, 기본 `300,3000`).
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
