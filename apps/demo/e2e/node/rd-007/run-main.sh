#!/bin/bash
# RD-007 본 측정. `press-loss.mjs` 두 시나리오를 순서대로 돌린다.
# 출처 RD-007에서 이관(RD-018). 실행법·판정선은 rd-007/README.md다.
#
# 순서:
# 1. single: 단일 눌림 N=3000. 소실(`lost`)을 센다.
# 2. multi: 페이지 10개, 페이지마다 눌림 300개. 누락(`missing`)·이중(`doubles`)을 센다.
#
# 폴링 비용(`poll-overhead.mjs`)은 이 스크립트에 없다. 따로 돌린다.
# 실행: 아무 디렉터리에서나 가능하다. 경로는 스크립트 자신 기준이다.
#
# `--import` 훅:
# - `console.ts`가 Python 소스를 `.py?raw`로 import한다.
# - `ts-resolve-hook.mjs` 하나로 충분하다. `?raw`도 처리한다.
# - `py-raw-hook.mjs`도 함께 등록한다. 함께 등록해도 문제가 없고 순서는 무관하다.
# - 근거는 rd-009/README.md "해석 훅"이다.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
H1="$DIR/../../../../../packages/pyodide-testkit/src/ts-resolve-hook.mjs"
H2="$DIR/../rd-009/py-raw-hook.mjs"
echo "### single N=3000 시작 $(date +%T)"
node --import "$H1" --import "$H2" "$DIR/press-loss.mjs" --scenario single --n 3000
echo "### multi k=300 pages=10 시작 $(date +%T)"
node --import "$H1" --import "$H2" "$DIR/press-loss.mjs" --scenario multi --k 300 --pages 10
echo "### 완료 $(date +%T)"
