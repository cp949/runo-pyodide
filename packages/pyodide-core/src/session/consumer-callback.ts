/**
 * 소비자 콜백을 부른다. 규칙은 `docs/design/08-session.md` 8.5(X1·X3).
 * - 콜백이 없으면 아무 일도 하지 않는다.
 * - 콜백이 던진 예외는 `reportError`(없으면 `console.error`)로 넘긴다.
 * - 예외가 core의 상태 전이를 끊지 않게 격리한다.
 */
export function callConsumer<A extends unknown[]>(
  callback: ((...args: A) => void) | undefined,
  ...args: A
): void {
  if (callback === undefined) return;
  try {
    callback(...args);
  } catch (error) {
    const report = (globalThis as { reportError?: (e: unknown) => void })
      .reportError;
    if (typeof report === "function") report(error);
    else console.error(error);
  }
}
