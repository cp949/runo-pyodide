# TRP-049 node의 `worker.terminate()`는 즉시 끝나지만 Chromium은 스크립트가 끝나지 않는 worker를 최대 약 2초 늦게 끝내, 재시작 뒤 공유 버퍼의 눌림이 옛 worker에 가로채인다

- 상태: ACTIVE
- 적용 조건: main이 `worker.terminate()`를 부른 뒤 새 worker를 만드는 재시작 경로(`createRunner`의 `stop()` 폴백·`reset()`·크래시 복구, REPL `reset()`)에서 옛 worker가 Python 무한 루프처럼 스크립트가 끝나지 않는 상태일 때. 옛 worker와 새 worker가 SharedArrayBuffer(interrupt buffer)를 공유할 때 특히(REPL `reset()`도 이전에는 공유했다). 재시작 시험을 쓸 때. 재시작·종료 직후 `page.workers().length`나 CDP `Target.getTargets` 개수로 worker 수를 판정하는 브라우저 확인에서, terminate 시점의 worker가 유휴가 아닐 때(`input()` 대기·`time.sleep`·실행 중).

## 오해하기 쉬운 신호

- node 시험(실제 pyodide worker 스레드)에서는 폴백 뒤 첫 `stop()`·`interrupt()`가 정상이라 결함이 없어 보인다. "재시작 뒤 새 run이 `print`를 정상 실행한다"까지만 보는 시험은 통과하고 `reset()` 뒤 interrupt도 브라우저에서 (idle 상태의 옛 worker라) 통과한다.
- 브라우저에서 `ready` 상태·worker 수(2개)·화면은 정상이고 `^C`만 찍힌 채 결과가 오지 않는다. `SEQ`·`ACK` 값은 연속·정상이라 프로토콜 규약 오류처럼 보인다(`ACK`가 눌림 수만큼 올랐는데 새 worker는 중단되지 않았다).
- worker 수 판정: 실행 중이던 worker를 `reset()`으로 terminate한 뒤 새 worker가 `ready`가 되어도 옛 worker가 CDP 목록에 남아 있어(2026-09-25 Chromium 측정, 아래 원인) worker가 2개(재시작이 겹치면 3개)로 보인다. "worker 1개"를 요구하는 판정은 통과하다가 타이밍에 따라 간헐 실패하고, 유휴 상태에서만 재시작하는 시험은 잔존이 없어 통과한다. 실패 원인이 재시작 결함이 아니라 종료 지연이다.

## 원인

- Chromium(Blink)은 terminate 요청 뒤 스크립트 실행이 끝나지 않는 worker를 약 2초 뒤에 강제 종료한다(실측: `close` 이벤트가 `terminate()`로부터 약 2.0초). 그동안 옛 worker의 Python은 계속 돌며 SIGINT를 폴링하고, 같은 buffer의 `SIGNAL`을 소비·`ACK`하고 `KeyboardInterrupt`를 삼킨다. 새 worker의 첫 눌림이 유실된다.
- 지연 조건은 "스크립트가 끝나지 않는 상태"가 아니라 "worker가 유휴가 아님"이다. 2026-09-25 Chromium 측정(core 단독, coincident 없음, 16회): `input()` 대기(`Atomics.wait`)·`time.sleep(30)`·`while True: pass` 중 terminate한 worker는 12/12회 목록에 1998~2004ms 남았고(대기 종류 무관, `Atomics.wait`가 아니어도 발생), 유휴 worker는 즉시(잔존 상한 1~3ms, 4회) 사라졌다. coincident + 동기 호출 중 terminate(20회 교대 중 busy 10회)도 1912~1913ms(9회, 나머지 1회 5207ms는 시계 점프 섞임 추정)로 같은 규모이고 core 단독에서도 재현되며 dom-bridge가 지연을 늘렸다는 증거는 없다(두 측정의 약 90ms 차이가 폴링 해상도인지 실제 차이인지는 분리하지 못했다). 사라진 id의 재등장은 0회였고 누적은 없다(20회 반복 뒤 옛 worker 전부 소멸·최종 1개).
- 새 worker의 `ready`는 회당 802.9~934.6ms(coincident 하니스 20회), `stop()` 폴백 뒤 약 1.8초라 잔존(약 2초)보다 빨라서 `ready` 시점에 옛 worker가 남는다(20회 중 19회 worker 2개). 종료 중인 유휴 worker·이전 잔존·새 worker가 겹치면 `reset()` 직후 스냅샷이 3개가 된다(20회 중 1회).

## 탐지/회피

- 세션마다 새 SharedArrayBuffer(interrupt buffer)와 송신기를 만든다(core `createRunner`의 `spawn()`, REPL `startSession`). REPL은 이전에 buffer를 핸들 수명으로 재사용했고 리셋이 `Atomics.store(SIGNAL, 0)`으로 옛 SIGINT만 지웠다. 그 지우기는 리셋 시점의 값만 지우므로, 리셋 뒤에도 약 2초 살아 있는 옛 worker가 같은 buffer의 이후 눌림을 읽는 것은 막지 못한다.
- REPL 브라우저 재현은 `apps/demo/e2e/checks/session-reset-check.mjs`의 `ccafter`(N=8)다. 수정 전 유실 1/8(7/8 통과), 수정 후 0/8(2회 실행 총 16회). 수정 전 유실률이 낮아 수정 후 0/8만으로는 효과를 통계적으로 입증하지 못한다 — "0/8이면 통과"만 보고 넘어가지 않는다(자연 재현율 판정의 한계는 `TRP-030`). 인과는 단위 시험(`packages/pyodide-repl/test/create-repl/reset.test.ts`: 리셋 뒤 새 프레임의 buffer가 옛 것과 다른 `SharedArrayBuffer`이고 Ctrl+C가 새 buffer에만 쓴다)이 고정한다. 핸들 수명 buffer 재사용으로 되돌리면 그 시험만 실패한다.
- 재시작 시험은 "재시작 뒤 `while True: pass` + interrupt → `interrupted`"까지 보고, 옛 worker의 `terminate()`를 지연시키는 worker 공장으로 2초 구간을 흉내 낸다(`session/runner-pyodide.test.ts`의 `lingeringWorkers()`). node의 즉시 종료만으로는 RED가 되지 않는다.
- 브라우저 재현은 재시작 직후(옛 worker가 닫히기 전, 약 2초 안) 첫 interrupt를 N회 반복한다.
- worker 수 판정은 고정 대기가 아니라 "옛 targetId가 목록에서 사라질 때까지" 조건 대기로 한다(정지 감지 상한은 잔존 약 2.0초의 몇 배로 넉넉히, `docs/design/09-testing.md` 9.7). "동시 worker 2개 이하"와 "최종 1개"를 나누어 판정한다. 소멸을 기다린 뒤 센 worker 수는 항상 1이라 `ready` 시점 지표가 아니다. 이 값으로 "`ready` 시점 worker 수"를 판정하면 잔존을 놓친다.
- 재시작을 설계하는 쪽(dom-bridge 등)은 옛 worker와 새 worker가 약 2초 동시에 존재한다고 전제한다. 옛 worker가 남아 있는 동안 공유하는 배타 자원·이름(`worker.proxy` 핸들러, `MessageChannel`)이 있으면 충돌한다.
- coincident 동기 호출 중 terminate한 옛 worker가 약 2초 뒤 종료돼도, 그 호출에 대한 main의 응답이 종료된 worker에 닿아 pageerror·콘솔 오류가 나지 않는다(`pnpm --filter demo e2e:dom-bridge` S5 stop 셀: 옛 slow 종료 뒤 pageerror 0). 이 스크립트의 worker 수 판정은 고정 대기가 아니라 옛 worker가 사라질 때까지의 조건 대기(`waitFor(() => page.workers().length === 1)`)다. `docs/design/16-dom-bridge.md` 16.10.
- `page.on('worker')` 이벤트로 세는 경우의 다른 함정은 `TRP-061`이다.
