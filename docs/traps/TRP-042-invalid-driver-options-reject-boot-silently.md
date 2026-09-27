# TRP-042 옵션이 틀린 worker는 `loadFailed`도 `ready`도 알리지 않고 부팅이 거부돼 main이 `loading`에서 멈춘다

- 상태: ACTIVE
- 적용 조건: main이 초기화 프레임의 `driver` 필드를 worker 검증 없이 그대로 보내는 코드(새 driver·새 소비자·프레임을 직접 만드는 시험). `WorkerDriver.parseOptions`가 던질 수 있는 값을 넘길 때.

## 오해하기 쉬운 신호

- 옵션 오류의 표면이 "예외 → `loadFailed`"일 것으로 기대하기 쉽다. 실제로는 main에 아무 알림이 없다: 상태가 `loading`에 머물러 pyodide 로드가 느린 것으로 보인다.
- worker 콘솔에는 `console.error("[worker] 부팅 시퀀스 예외")` 한 줄만 남고, 시험이 worker 콘솔을 보지 않으면 `ready` 대기 시간 초과로만 드러난다.

## 원인

- `bootWorker`가 `parseOptions`·`createSession`을 RPC 생성보다 앞에 둔다. 예외가 나면 RPC가 없어 `loadFailed`를 보낼 통로가 없고 `runWorker`가 예외를 콘솔에만 남긴다(`boot-driver-options.test.ts`가 이 순서를 고정한다).

## 탐지/회피

- main이 worker를 만들기 전에 같은 파서(`packages/pyodide-core/src/protocol/run-driver-options.ts`의 `parseRunDriverOptions`, worker 코드와 분리해 둠)로 검증하고 틀리면 worker·버퍼를 만들지 않고 동기로 던진다(`createRunner`). 새 driver도 옵션 파서를 worker 코드와 분리해 main이 재사용할 수 있게 둔다.
- 시험: `runner.test.ts`의 "…이면 worker를 만들기 전에 동기로 던진다"(`test.each`, 옵션 오류 종류별).
