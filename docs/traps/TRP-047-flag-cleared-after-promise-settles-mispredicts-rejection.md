# TRP-047 결과 Promise 정착 뒤 풀리는 `inFlight` 플래그로 "run이 받아들여질지"를 예측하면 콜백 안 재호출에서 낡는다

- 상태: ACTIVE
- 적용 조건: core `run()`의 거부(`busy` 등)를 예측하는 코드를 새로 쓸 때(예: 거부될 `run()`이 화면을 건드리지 않게 하려고 상태·플래그로 판정). 예측에 `run()`의 Promise `finally`에서 내리는 플래그를 쓰면 아래 결함이 생긴다.

## 오해하기 쉬운 신호

- `finally` 콜백은 core가 슬롯을 비우고 Promise를 resolve한 뒤 마이크로태스크에서 돈다. core가 `ready`를 알리는 콜백(`onStatus`) 안이나 `resolve` 직후 같은 동기 구간(예: 실행 중 `reset(); run(code)`)에서 `run()`을 다시 부르면 core는 슬롯이 비어 받아들이는데 플래그는 아직 참이라 "거부될 것"으로 잘못 예측해 화면을 준비하지 않는다. 그 run은 플래그를 올리지 않았으므로, 옛 run의 `finally`가 플래그를 내린 뒤 부른 세 번째 `run()`은 거꾸로 "받아들여질 것"으로 예측돼 거부(`busy`)되면서 화면을 지운다.
- 결과: 출력 꼬리가 남아 다음 `input()` 프롬프트가 이전 출력을 물려받는다. 일반 순서(결과를 `await`한 뒤 다음 `run()`)의 시험은 모두 통과한다.

## 원인

- 슬롯 점유의 진실은 core 안(`active` 슬롯·`waiting-input`)에 있다. 상태만으로는 `loading`·`restarting` 대기 중 run을 알 수 없고, 바깥 플래그는 정착 시점이 core와 어긋난다.

## 탐지/회피

- 회피: 거부를 예측하지 않는다. core `createRunner`의 `onRunAccepted`(수락된 `run()`마다 동기로 한 번, 거부에서는 불리지 않는다)에서 화면을 준비한다. 실행창은 `terminal-runner.ts`의 `prepareScreen`을 그 콜백에 연결한다. 슬롯 점유를 직접 읽어야 하면 core `RunnerHandle.busy`와 `status`를 그 시점에 읽고 바깥 플래그를 두지 않는다.
- 시험: `terminal-runner-screen.test.ts`(실제 core + 공용 가짜 worker)의 "실행 시작에 꼬리를 비워…"(동기 재호출), "끝난 run 뒤 재시작 대기 중에 부른 run은 슬롯이 비어 있으므로 화면을 준비한다", "실행 중 reset 직후 같은 틱에 부른 run은…", "reset 직후 받아들여진 run이 재시작을 기다리는 동안…", "대기 run이 있는 onStatus(ready) 콜백 안에서…".
