# `input()`은 worker를 멈추는 동기 대기로, REPL 프롬프트 읽기는 비동기로 둔다

배경:

- CPython에서 `input()` 대기 중에는 다른 코드가 돌지 않는다.
- pyodide의 `setStdin` 콜백도 문자열 동기 반환을 요구한다.
- REPL 프롬프트 대기는 사용자 코드가 없는 구간이다. worker를 멈출 이유가 없다.
- 멈추면 main→worker 요청(Tab 완성)이 불가능해진다(이전 구현의 동기 브리지 함정, `docs/design/11-known-traps.md` "새 구조에서 제거됨").

결정:

- 프롬프트 읽기(`readLine`)와 Tab 완성은 비동기 RPC다.
- `input()`·`sys.stdin` 읽기는 메일박스 `Atomics.wait`다.
- `time.sleep`도 비동기 대기로 바꾸지 않는다. 20ms 블로킹 조각으로 둔다(`docs/design/03-ctrl-c.md` 2.4).

대가:

- 프롬프트 대기 중 asyncio 콜백이 돈다.
- 이것은 `python`이 아니라 `python -m asyncio`의 동작이다.
- 이전 구현의 동기 모드도 콜백을 다음 실행 때 돌려 `python`과 같지 않았다.
- 그래서 `python -m asyncio` 쪽으로 정렬한다(사용자 결정 2026-09-21).

## Considered Options

- JSPI로 `input()`도 비동기화: 기각.
  - `setStdin` 콜백은 wasm→JS 프레임이라 그 안에서 suspend할 수 없다.
  - `builtins.input`·`sys.stdin`을 Python 레벨에서 `run_sync`로 교체해야 한다.
  - `can_run_sync()`가 거짓인 컨텍스트와 JSPI 없는 환경에서 깨진다.
  - 대기 중 다른 콜백이 도는 의미 변화가 생긴다.
  - 메일박스 대기는 `createStdinCallback`의 `wait()` 주입점 뒤에 있다. 정책이 바뀌면 어댑터만 바꾼다.

## Consequences

- 메일박스 대기 중 worker는 RPC에 답하지 못한다.
- `input()` 안 Tab 완성은 이 구조로 풀리지 않아 보류로 남는다(이전 구현 RD-016b, `docs/design/12-previous-implementation.md`).
- 배경 콜백의 `input()`은 read-guard로 REPL 읽기 뒤에 시작한다(`docs/design/04-stdin-input.md` 3.2).
