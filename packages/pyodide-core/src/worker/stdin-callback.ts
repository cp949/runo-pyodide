/**
 * `pyodide.setStdin({ stdin })`에 넘길 동기 stdin 콜백(04-stdin-input.md 3.1).
 * 이 모듈이 소유하는 것(01-protocols.md 1.3):
 * - "`readInput` 알림 → 메일박스 대기" 순서
 * - "취소 표식 → `KeyboardInterrupt`" 변환
 *
 * `pyodide`와 `protocol/`을 import하지 않는다.
 * - `boot.ts`가 RPC 알림·메일박스 리더(`requestInput`·`wait`)를 주입한다.
 * - `attachRuntime`이 SIGINT 클로저 둘(`signalInterrupt`·`checkInterrupt`)을 주입한다.
 *
 * 취소 변환은 콜백 안에서 SIGINT를 쓰고 곧바로 소비한다: `signalInterrupt()`(요청 번호 +1 → SIGINT 2) →
 * `checkInterrupt()`(`pyodide.checkInterrupt()`).
 * GIL이 풀린 콜백 안이라 `checkInterrupt()`는 `FS.ErrnoError(EINTR)`를 던진다.
 * CPython이 EINTR 뒤 신호를 처리해 `input()` 호출 지점에서 `KeyboardInterrupt`를 올린다(PEP 475).
 *
 * 이전 구현이 확인한 금지된 대안 5종(TRAP-05):
 * - SIGINT(2)만 쓰고 정상 반환: 폴링 시점이 읽기 밖이라 HANG 또는 엉뚱한 프레임에서 중단된다.
 * - 일반 `Error`를 던진다: `input()`에서 `OSError`가 된다.
 * - 취소를 그대로 `null`로 돌려준다: `EOFError`가 된다(취소가 아니다) — `null` 반환은 RD-048부터 EOF 전용이다.
 * - `errno`만 가진 `Error`를 던진다: pyodide가 죽는다.
 * - 버퍼 없이 `FS.ErrnoError`만 던진다: CPython이 신호를 못 찾아 읽기를 무한 재시도한다.
 */

/** {@link createStdinCallback}이 받는 것. 전송 수단(RPC·메일박스·pyodide)을 주입한다. */
export interface StdinCallbackDeps {
  /**
   * `readInput` 알림. `wait()`보다 먼저 부른다.
   * postMessage는 호출 즉시 큐에 들어간다. 뒤이어 정지해도 전달된다(01-protocols.md 1.3).
   */
  requestInput(cancelable: boolean): void;

  /** 메일박스 대기(`Atomics.wait`). 한 줄·취소·EOF 표식. 오류 표식이면 `Error`를 던진다. */
  wait():
    { kind: "line"; text: string } | { kind: "cancelled" } | { kind: "eof" };
  /**
   * 요청 번호를 올린 뒤 SIGINT(2)를 쓴다. `attachRuntime`이 `() => signalInterrupt(interruptBuffer)`를 넣는다.
   * 번호를 올리지 않으면 핸들러가 main의 재전송으로 보고 버린다(TRAP-28).
   */
  signalInterrupt(): void;

  /** `pyodide.checkInterrupt()`. SIGINT가 있으면 `FS.ErrnoError(EINTR)`를 던진다. */
  checkInterrupt(): void;
}

/**
 * `pyodide.setStdin({ stdin })`에 넘길 동기 콜백을 만든다. 항상 cancelable=true이고 프롬프트는 없다(main이 꼬리로 정한다).
 *
 * 반환값:
 * - 줄: 문자열을 그대로 돌려준다. pyodide가 끝에 `\n`이 없으면 붙인다(`LegacyReader`, 고정 버전 `PYODIDE_VERSION`). 이 콜백은 `\n`을 붙이지 않는다.
 * - `eof`: `null`을 돌려준다. pyodide가 `null`을 EOF로 해석한다. SIGINT는 쓰지 않는다. 입력 끝은 취소가 아니다.
 * - `cancelled`: SIGINT로 바꾼다(`signalInterrupt` → `checkInterrupt`).
 *
 * 예외 경로:
 * - `checkInterrupt()`가 던지지 않으면(버퍼 미연결 등) 취소를 EOF로 떨어뜨린다. 경고 한 줄을 남기고 `null`을 돌려준다(→ `EOFError`).
 * - 소비되지 않은 SIGINT가 남으면 다음 문장이 엉뚱한 지점에서 죽는다.
 * - `wait()`가 던진 오류는 그대로 전파한다. `input()`에서 `OSError`가 된다(main의 `fail`).
 */
export function createStdinCallback(
  deps: StdinCallbackDeps,
): () => string | null {
  return () => {
    deps.requestInput(true);
    const result = deps.wait();
    if (result.kind === "line") return result.text;
    if (result.kind === "eof") return null;
    deps.signalInterrupt();
    deps.checkInterrupt();
    console.warn(
      "[worker] checkInterrupt가 SIGINT를 소비하지 않아 입력 취소를 EOF로 처리한다",
    );
    return null;
  };
}
