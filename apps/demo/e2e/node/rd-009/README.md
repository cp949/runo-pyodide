# node 통계 — RD-009(유휴 sleep 중 Ctrl+C)

실제 pyodide(node)에 저장소 worker 모듈을 `boot.ts`와 같은 순서로 배선하고(`createConsole` →
`attachRuntime`(WebLoop 재보고 억제 포함) → `createSubmissionRunner`), 별도 스레드
(core `test/roles/interrupt-presser.ts`)가 저장소 송신 프로토콜(`signalInterrupt`)로 눌림을 쓴다.
JSPI 있음·없음 × 5 프로그램 × N=30 = 300시행이라 수 분 걸리고 타이밍으로 판정하므로 `pnpm test`에 넣지 않는다.

출처 RD-009에서 이관(RD-018).

## 해석 훅

`console.ts`·`sigint-handler.ts`·`sleep-slice.ts`가 Python 소스를 `./*.py?raw`로 import한다.
vitest·tsdown은 각자 내장·플러그인으로 처리한다. 맨 node 실행에는 처리가 없어 훅이 필요하다.

- `packages/pyodide-testkit/src/ts-resolve-hook.mjs` 하나로 충분하다.
  - 확장자 없는 상대 import를 푼다.
  - `?raw` import를 파일 내용 문자열 모듈로 읽는다.
- 이 폴더의 `py-raw-hook.mjs`는 `?raw`만 처리한다. 단독으로는 확장자 없는 import를 못 푼다.
- 아래 명령은 두 훅을 함께 등록한다. 함께 등록해도 문제가 없고, 등록 순서도 무관하다.
- 실측(node v24.21.0): `ts-resolve-hook.mjs`만, 둘 다(두 순서), `py-raw-hook.mjs`만 등록해 `console.ts` 로드를 확인했다.
  - `py-raw-hook.mjs`만 등록하면 `../worker/top-level-await`를 못 찾아 실패한다.
  - 나머지 셋은 로드된다.

## 실행

```bash
H1=packages/pyodide-testkit/src/ts-resolve-hook.mjs
H2=apps/demo/e2e/node/rd-009/py-raw-hook.mjs
cd /path/to/repo   # 레포 루트

# JSPI 있음·없음 순서대로 N=30 (약 8~9분, CPU 경합을 피하려고 동시 실행하지 않는다)
bash apps/demo/e2e/node/rd-009/run-n30.sh

# 낱개 실행
node --import $H1 --import $H2 apps/demo/e2e/node/rd-009/sleep-stats.mjs \
  --mode jspi --n 30 --press 300,3000

node --import $H1 --import $H2 apps/demo/e2e/node/rd-009/sleep-stats.mjs \
  --mode nojspi --progs loop002,loop001 --n 30

# 양성 대조(하니스 검출력, 약 2~3분): 신호 없이 유한 형태로 완주시켜 트레이스백이 없는지 본다
node --import $H1 --import $H2 apps/demo/e2e/node/rd-009/sleep-stats.mjs \
  --mode jspi --dry --n 30
```

`--mode jspi|nojspi`(`nojspi`는 `loadPyodide` 전에 `WebAssembly.Suspending`·`promising`·`Suspender`를
지운다, `sigint-handler-nojspi.test.ts`와 같은 방법), `--progs`(콤마 구분, 기본
`sleep5,loop01,loop002,loop0015,loop001`), `--n`(기본 30), `--press min,max`(균등 무작위 ms, 기본
`300,3000`, 시행마다 다시 뽑는다), `--dry`(양성 대조, 아래).

프로그램: `sleep5` = `started(); time.sleep(5)`, `loopXX` = `started()` 다음 `while True: time.sleep(<초>)`
(`01`→0.1, `002`→0.02, `0015`→0.015, `001`→0.01). `started()`는 presser 스레드에 "Python이 들어갔다"를
알리는 JS 콜백이고, presser는 그 시각 기준 무작위 지연 뒤 `signalInterrupt`를 쓴다(`interrupt-presser.ts`
`waitStarted: true`). 지연은 `started()`가 불린 시각(`process.hrtime.bigint()`, 메인 스레드와 presser
스레드가 같은 원점을 쓴다)부터 `screen.stderr`에 첫 바이트가 온 시각까지다.

## 판정선

| 스크립트                | 통과 조건                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `sleep-stats.mjs`(실측) | 프로그램별 `interruptedCount === n && exactMatchCount === n && extraStderrCount === 0 && over200 === 0` |
| `sleep-stats.mjs --dry` | 프로그램별 `interruptedCount === 0`("중단 없음")                                                        |

`exactMatch`는 `screen.stderr`가 `Traceback (most recent call last):\n  File "<console>", line N, in
<module>\nKeyboardInterrupt\n` 형태(사용자 프레임 하나, `<sleep-slice>`·`<sigint-handler>` 없음)와 일치하는지다.
콘솔 인스턴스를 시행마다 새로 만들지 않아(속도) 줄 번호(`N`)가 시행마다 늘어나므로 정규식으로 본다(고정 값이
아니라 **형태**의 정확 일치).

결과는 `E2E_RESULTS_DIR`(기본 `apps/demo/e2e/results/`)에 `node-sleep-<mode>.json`(실측)·
`node-sleep-<mode>-dry.json`(양성 대조)로 쓴다. 실측 결과에는 시행별 상세(`trials`)가 파일에는 남고 콘솔
요약에는 빠진다(150줄은 너무 길다).

## `--dry`가 저장소 코드를 건드리지 않고도 "신호 없음"을 재현하는 방법

"눌림 스레드가 SIGINT를 쓰지 않는 `--dry`"가 이 스크립트의 요구다. `interrupt-presser.ts`는 저장소
시험 코드가 공유하는 파일이라 고치지 않는다(재사용만 한다). 그래서 이 스크립트의 `--dry`는 presser 스레드를
아예 띄우지 않고, 각 프로그램을 무한 `while True` 대신 **총 실행 시간이 비슷한 유한 `for` 반복**(`sleep5`는
`time.sleep(1)`)으로 바꿔 눌림 없이 완주시킨다. `screen.stderr`가 비어 있으면(트레이스백 없음) "중단 없음"이다.
이것이 증명하는 것: 정상 측정 코드(`interrupted = screen.stderr.includes("KeyboardInterrupt")`)가 "완주"와
"중단"을 실제로 구별한다 — 즉 하니스가 뭔가를 눌러서가 아니라 **눌렸을 때만** 중단을 보고한다는 뜻이다. 실측
쪽(`--dry` 없음)의 낮은 지연(중앙값 수십 ms)과 대조하면 하니스가 실제 신호에 반응한다는 것도 같이 보인다.

## 변이 상태 측정(TRAP-25 재확인, `docs/history/first-roadmap.md` RD-009 완료 기준)

`sleep-slice.py`의 `secs <= SLEEP_SLICE`(≤20ms) 분기에서 `poll()` 호출을 수동으로 지우면(편집으로, `git
stash` 쓰지 않는다) 폴링이 pyodide 자체의 유휴 틱에만 의존하게 돼 지연이 늘어난다(이전 구현 실측:
`loop002` 최대 262ms, 약 13배). 통과/실패 판정 항목이 아니라 근거 기록이다.

```bash
# packages/pyodide-core/src/worker/sleep-slice.py의 `if secs <= SLEEP_SLICE:` 블록에서
# `poll()` 호출 한 줄만 지운 뒤:
node --import $H1 --import $H2 apps/demo/e2e/node/rd-009/sleep-stats.mjs \
  --mode jspi --progs loop002,loop001 --n 30

# 결과를 옮긴 뒤 반드시 원복:
git checkout -- packages/pyodide-core/src/worker/sleep-slice.py
```

## 판정의 한계

- 콘솔 인스턴스(`PyodideConsole`)를 시행마다 새로 만들지 않고 재사용한다(속도). `<console>` 줄 번호가
  시행마다 늘어나므로 `exactMatch`는 정규식(형태)으로 본다 — vitest의 `CONSOLE_TRACEBACK` 상수(줄 1 고정)와는
  다른 기준이다.
- `latencyMs`는 presser 스레드가 보고한 상대 지연(`atMs[0]`, `started()`가 불린 시각 기준)에 메인 스레드가
  캡처한 `started()` 절대 시각을 더해 근사한다. 두 스레드가 `process.hrtime.bigint()`(같은 원점)를 쓰므로
  스레드 전환 지연(수십 µs급)만큼의 오차가 있고, 목표 정밀도(ms 단위, 200ms 판정선)에는 무시할 수 있다.
- `--press`로 지정한 지연 하한(기본 300ms)은 프로그램 제출(줄 2개 push + 빈 줄)에 걸리는 시간보다 넉넉히 커야
  한다(그렇지 않으면 눌림이 아직 시작하지 않은 시나리오에 떨어질 수 있다). 하한을 100ms 아래로 낮추지 않는다.
