# TRP-020 `<console>` 밖 파일명에서 취소하면 핸들러가 버려 읽기 재시도 루프가 된다

- 상태: ACTIVE
- 적용 조건: stdin 취소(또는 실행 중 중단)를 node 시험에서 재현할 때 `pyodide.runPython(...)`으로 코드를 돌릴 경우. 콘솔 러너를 거치지 않는 모든 실행 경로가 해당한다.

## 오해하기 쉬운 신호

- 예외가 나지 않는다. 취소를 보냈는데 아무 일도 일어나지 않은 것처럼 보인다.
- 시험이 실패하지 않고 **스위트가 멈춘다.** CPython이 읽기를 다시 시도하고 각본이 남아 있으면 그 줄을 읽어 "취소가 무시되고 값이 들어왔다"가 되며, 각본이 비면 `OSError`로 끝나 실패 사유가 엉뚱해진다.
- 같은 코드를 브라우저(실제 REPL)에서 돌리면 정상 동작한다. 차이는 파일명뿐이다.

## 원인

SIGINT 핸들러는 스택에 `<console>` 프레임이 있을 때만 `KeyboardInterrupt`를 올린다(사용자 코드가 아닌 곳에서 중단하지 않기 위한 규칙, `docs/design/03-ctrl-c.md` 2.4). `pyodide.runPython`이 만드는 프레임의 파일명은 `<exec>`라 규칙에 걸리지 않고, 핸들러는 ack만 하고 신호를 버린다. 콜백이 던진 `EINTR`은 CPython이 "신호 처리 뒤 재시도"로 해석하므로(PEP 475) 읽기가 다시 열린다.

## 탐지/회피

- 취소·중단 시험은 **콘솔 러너 경로**로 돌린다: `createConsole` → `createInterruptBuffer` → `installSigintHandler` → `setInterruptBuffer` → `createSubmissionRunner`로 제출하고 `screen.stderr`로 트레이스백을 본다.
- 여러 줄 프로그램이 필요하면 `exec(<JSON 문자열>)` 한 줄 제출로 만든다(콘솔 러너는 한 줄 제출을 다룬다).
- 각본이 소진되면 던지게 해 둔다. "기대보다 많이 읽는 코드"가 EOF로 조용히 통과하지 않는다.
- 프레임 규칙 때문에 취소가 버려지는 경로(모듈 함수에서 부른 `input()` 등)는 범위 밖으로 확정하고 관찰만 기록한다.
