# node 통계 — RD-007(눌림 소실·폴링 비용)

실제 pyodide(node)에 저장소 worker 모듈을 worker와 같은 순서로 배선하고, 별도 스레드가 저장소 송신기로 눌림을
쓴다. 5분 이상 걸리고 타이밍으로 판정하므로 `pnpm test`에 넣지 않는다.

출처 RD-007, `_works/_completed/20260922-07-rd-007-ctrl-c-running/verify/node/`에서 이관(RD-018 DELTA-04).

## 실행

레포 루트에서:

```bash
H1=./packages/pyodide-testkit/src/ts-resolve-hook.mjs
H2=./apps/demo/e2e/node/rd-009/py-raw-hook.mjs
N=apps/demo/e2e/node/rd-007

# 단일 눌림 소실 (약 6분)
node --import $H1 --import $H2 $N/press-loss.mjs --scenario single --n 3000

# 연타 누락·이중 (약 40초)
node --import $H1 --import $H2 $N/press-loss.mjs --scenario multi --k 300 --pages 10

# 폴링 비용 (약 3분, 단독 실행 — 다른 부하가 있으면 비율이 흔들린다)
node --import $H1 --import $H2 $N/poll-overhead.mjs --rounds 10

# 셋을 순서대로(레포 루트에서, 상대경로는 스크립트 자신의 위치 기준)
./apps/demo/e2e/node/rd-007/run-main.sh
```

`--import <훅>`은 확장자 없는 상대 import(`../protocol/rpc`)를 푸는 해석 훅이다(Node 타입 제거 실행).
`enum`·`namespace`가 없는 소스만 이렇게 로드된다 — 현재 core `protocol/`·repl `worker/`가 그렇다.

**두 훅이 모두 필요하다(RD-018 DELTA-04에서 실측)**: RD-007 완료 시점에는 `ts-resolve-hook.mjs` 하나로
충분했지만, 그 뒤(DELTA-00 무렵) `console.ts`·`sigint-handler.ts`·`sleep-slice.ts`가 Python 소스를
`./*.py?raw`로 import하도록 바뀌어 `createConsole`을 쓰는 이 폴더의 스크립트도 `apps/demo/e2e/node/rd-009/`의
`py-raw-hook.mjs`가 필요하다(등록 순서는 rd-009 README와 같다 — `ts-resolve-hook.mjs` 먼저, `py-raw-hook.mjs`
나중). `py-raw-hook.mjs` 사본을 이 폴더에 새로 두지 않고 rd-009 쪽을 참조한다(내용이 저장소 무관·범용이라
중복을 피한다).

## 판정선

| 스크립트                           | 통과 조건                                                           |
| ---------------------------------- | ------------------------------------------------------------------- |
| `press-loss.mjs --scenario single` | `lost === 0`. 참고: `recoveredLatencyMs.max`가 20ms 안팎            |
| `press-loss.mjs --scenario multi`  | `missing === 0 && doubles === 0`                                    |
| `poll-overhead.mjs`                | `ratios.repo.loop <= 1.03 && ratios.repo.str <= 1.03`(`pass: true`) |

결과는 `E2E_RESULTS_DIR`(기본 `apps/demo/e2e/results/`)에 `node-*.json`으로 쓴다.

## 하니스 검출력(양성 대조)

측정값이 "전부 0"일 때 그것이 구현이 옳아서인지 하니스가 아무것도 못 보기 때문인지 구분해야 한다.
`--mutate`로 눌림 스레드를 변조해 하니스가 결함을 실제로 검출하는지 증명한다(저장소 코드는 건드리지 않는다).

| `--mutate`                  | 하는 일                                   | 기대                                                         |
| --------------------------- | ----------------------------------------- | ------------------------------------------------------------ |
| `lose-first`                | 눌림의 첫 SIGINT 쓰기를 삼킨다(소실 강제) | `lost 0`, `recovered`가 라운드 수와 같다 — 재전송이 복구한다 |
| `lose-first+no-resend`      | 위 + 재전송 상한 0                        | `lost`가 라운드 수와 같다 — 하니스가 소실을 검출한다         |
| `double-press`              | 눌림마다 2ms 뒤 한 번 더 보낸다           | `doubles > 0` — 하니스가 이중을 검출한다                     |
| `lose-first+resend-new-seq` | 소실 복구 재전송이 새 요청 번호를 쓴다    | 이중은 나지 않는다(핸들러가 아직 처리하지 않은 번호다)       |

## 판정의 한계

- `single`의 `lost`는 감시견(기본 1500ms)이 라운드를 구조했는지로 센다. 감시견이 돌기 전에 재전송이 복구하면
  소실로 세지 않는다 — 이 스크립트가 재는 것은 "재전송까지 포함한 소실"이다.
- `multi`의 `kiDelta`는 다음 눌림 직전에 `KeyboardInterrupt` 수를 읽어 구간 차이를 낸다. `--gap`이 너무 짧으면
  처리가 다음 구간으로 밀려 `0`과 `2`가 같이 늘어난다(합계는 맞는다).
- 종료용 눌림이 만든 중단은 집계에서 빠진다: 마지막 눌림 뒤 `settleMs`(100ms)를 두고 종료 플래그를 세우며,
  `mark()`가 그 플래그를 보고 세지 않는다.
