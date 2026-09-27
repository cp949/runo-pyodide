/** 규칙: `docs/design/08-session.md` 8.5. 소비자 콜백 예외를 격리한다(X1·X3). */
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
