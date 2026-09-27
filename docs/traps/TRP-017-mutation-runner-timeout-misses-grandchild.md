# TRP-017 변이 검사기의 `spawnSync` timeout이 `pnpm exec vitest`에는 듣지 않는다

- 상태: ACTIVE
- 적용 조건: `tools/mutate.mjs`(또는 같은 형태의 `spawnSync("pnpm", ["exec", "vitest", …], { timeout })`)로 변이 검사를 돌리는데, 어떤 변이가 시험 스위트를 **멈추게** 할 때. worker 시험이 동기 `Atomics.wait`에 갇히는 변이가 전형이다.

## 오해하기 쉬운 신호

- 스펙에 `timeout: 60000`이 있으니 60초 뒤 다음 변이로 넘어갈 것처럼 보인다. 실제로는 10분 넘게 매달린다(실측 10분 57초).
- 도구가 아무 출력도 내지 않는다. 변이별 결과는 전부 끝난 뒤 한꺼번에 찍히므로 "시험이 느리다"와 구별되지 않는다.
- `timeout`을 더 낮춰도 달라지지 않는다. 낮춘 값이 실제로 적용됐는지 확인할 수단이 로그에 없다.
- 멈춘 변이를 죽이려고 도구 프로세스를 끊으면 `finally`의 원복이 돌지 않아 **소스가 변이 상태로 남는다**. 그 뒤의 시험·빌드는 엉뚱한 결과를 낸다.

## 원인

`spawnSync`의 timeout은 직접 자식(`pnpm.cjs`)만 겨눈다. 손자 프로세스(`pnpm` → `vitest.mjs` → 포크 워커 `vitest/dist/workers/forks.js`)는 살아남아 **stdout 파이프를 붙잡는다.** `spawnSync`는 그 파이프가 닫힐 때까지 계속 막힌다.

시험 자체의 timeout도 못 뜬다. worker 시험이 시험 스레드와 같은 스레드에서 `Atomics.wait`에 갇히면 이벤트 루프가 돌지 않아 vitest가 타이머를 실행할 수 없다.

## 탐지/회피

- 멈춘 포크 워커만 밖에서 끊는다. 그러면 `spawnSync`가 돌아오고 도구가 스스로 원복한 뒤 다음 변이로 넘어간다.

```bash
kill -9 $(pgrep -f 'vitest/dist/workers/fork[s].js')
```

- 한 변이만 따로 볼 때는 bash로 감싸 파이프까지 정리한다(대괄호는 [TRP-018](./TRP-018-pkill-f-matches-own-shell.md)).

```bash
timeout -s KILL 60 pnpm exec vitest run <파일> --reporter=dot
code=$?; pkill -9 -f 'vitest/dist/workers/fork[s].js'; exit $code
```

- 실행 뒤 **항상 `git status`로 대상 파일이 원복됐는지** 본다.
- 멈추는 변이가 있을 것 같으면 배치를 2~3종으로 쪼개 돌린다. 어떤 변이에서 멈췄는지 가려낼 수 있고, 한 배치가 매달려도 나머지 결과는 남는다.
- 결과에 "단정 실패로 죽었는지, 멈춰서 죽었는지"를 구분해 적는다(종료 코드 137 = SIGKILL). 멈춤도 유효한 검출이지만 사람 개입이 필요한 종류다.
