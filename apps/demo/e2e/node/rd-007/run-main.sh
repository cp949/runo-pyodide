#!/bin/bash
# 본 측정: 단일 눌림 N=3000 → 연타 catch-loop 300×10페이지.
# 출처 RD-007, `_works/_completed/20260922-07-rd-007-ctrl-c-running/verify/node/`에서 이관(RD-018 DELTA-04).
# 두 훅이 모두 필요하다(README "두 훅이 모두 필요하다" 참고 — RD-007 완료 이후 console.ts가 `.py?raw`를 쓰게 됨).
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
H1="$DIR/../../../../../packages/pyodide-testkit/src/ts-resolve-hook.mjs"
H2="$DIR/../rd-009/py-raw-hook.mjs"
echo "### single N=3000 시작 $(date +%T)"
node --import "$H1" --import "$H2" "$DIR/press-loss.mjs" --scenario single --n 3000
echo "### multi k=300 pages=10 시작 $(date +%T)"
node --import "$H1" --import "$H2" "$DIR/press-loss.mjs" --scenario multi --k 300 --pages 10
echo "### 완료 $(date +%T)"
