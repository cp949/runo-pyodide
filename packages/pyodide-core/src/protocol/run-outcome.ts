/**
 * 실행 driver의 결말(RPC `runCode`의 응답). worker `runDriver`가 만들고 main `createRunner`가 받는다.
 * main은 worker 코드를 import하지 않는다(`?raw` Python·pyodide 타입이 딸려 온다).
 * 두 쪽이 공유하는 타입을 여기 둔다.
 */

/**
 * 코드가 실행된 뒤 `runCode`가 돌려주는 결말.
 * - `ok`: 정상 종료.
 * - `error`: 처리되지 않은 예외.
 *   - `errorType`은 예외 클래스 이름이다.
 *   - `SyntaxError`의 하위 클래스(`IndentationError`·`TabError`)는 `"SyntaxError"`로 통일한다. 구체 이름은 `traceback`에 있다.
 * - `interrupted`: 처리되지 않은 `KeyboardInterrupt`. 출처와 무관하다.
 * - `exit`: `SystemExit`. CPython 규칙을 따른다.
 *   - `None` → 0, `int` → 그 값.
 *   - 그 밖 → 1, stderr에 `str(코드)`.
 *   - `code`가 int32 범위 밖이면 OS가 보는 값(하위 8비트)으로 줄인다.
 */
export type RunOutcome =
  | { kind: "ok" }
  | { kind: "error"; errorType: string; traceback: string }
  | { kind: "interrupted"; traceback: string }
  | { kind: "exit"; code: number };
