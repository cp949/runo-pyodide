# TRP-031 공용 asyncio 함수에 "첫 호출 한 번" 주입을 걸면 콘솔 자신의 호출에 걸려 잘못된 이유로 RED가 난다

- 상태: ACTIVE
- 적용 조건: 실제 pyodide 콘솔 조립(`setupConsoleRunner`)에서 `asyncio.ensure_future`·`call_soon`·
  `asyncio.futures._set_result_unless_cancelled` 같은 공용 asyncio 함수를 교체해 특정 호출 지점에만 SIGINT를 주입하는 시험을 쓸 때.

## 오해하기 쉬운 신호

- 수정 전 시험이 실패하므로 "RED 확인"으로 넘어가기 쉽다. 실제 실패 내용은 기대한 노이즈(`coroutine ... was never awaited`)가
  아니라 stderr 빈 문자열(중단 자체가 일어나지 않음)이다. 수정 뒤에도 같은 이유로 계속 실패하거나, 무관한 변경으로 우연히
  통과해 수정이 효과 있는 것처럼 보일 수 있다.

## 원인

- `runner.run()`은 제출마다 콘솔이 `asyncio.ensure_future`로 실행 task를 만든다. 주입 조건이 "첫 호출에서 한 번"이면 그 호출에
  걸린다. 그 순간은 `active`가 없고 사용자 프레임도 없어 SIGINT 핸들러가 눌림을 버린다("그 밖" 폐기 규칙). 정작 목표인
  `run_sync` 래퍼의 `ensure_future(guard(...))` 호출에는 주입이 없다.
- 같은 공용 함수를 콘솔·WebLoop·사용자 코드가 함께 부르므로 호출 순서만으로 지점을 고를 수 없다.

## 탐지/회피

- 주입 조건을 호출 인자나 호출자로 좁힌다(예: `getattr(args[0], '__name__', '') == 'guard'`).
- 주입 횟수를 함께 단언한다(예: `len(_hits) == 1`) — 주입 지점을 한 번도 안 지나는 공회전을 잡는다.
- ABC 검사(`abc.ABCMeta.__subclasscheck__`)를 교체할 때 래퍼 안에서 `isinstance`·`issubclass`를 ABC에 쓰면 그 검사가 다시 래퍼로 들어와 재귀한다. 조건은 `is` 비교만 쓴다(예: `cls is collections.abc.Generator and subclass is pyodide.webloop.PyodideTask`).
- WebLoop가 만드는 Task 클래스는 `asyncio.Task`가 아니라 `pyodide.webloop.PyodideTask`다. `asyncio.Task` 식별로 조건을 걸면 주입이 한 번도 일어나지 않는 공회전이 되고, 위 주입 횟수 단언이 잡는다.
- RED 단계에서 실패 메시지가 기대한 노이즈·트레이스백인지 눈으로 확인한다. "실패했다"만으로 RED를 인정하지 않는다.
