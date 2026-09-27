/**
 * 터미널과 무관한 비동기 시험 도우미(RD-043). `tick`은 매크로태스크 한 번을 기다리고, `observe`는 아직 끝나지
 * 않은 promise가 시험을 멈추지 않게 현재 상태를 읽는 함수로 바꾼다.
 */

/** 매크로태스크 한 번. write 콜백·await 사슬이 끝나기를 기다린다. */
export const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

export type Outcome<T = unknown> =
  | { state: "pending" }
  | { state: "resolved"; value: T }
  | { state: "rejected"; reason: unknown };

/**
 * promise의 현재 상태를 읽는 함수를 돌려준다. 끝나지 않는 읽기가 시험을 멈추지 않게 하고,
 * reject된 promise에 핸들러가 붙어 있어 처리되지 않은 rejection이 생기지 않는다.
 */
export function observe<T>(promise: Promise<T>): () => Outcome<T> {
  let outcome: Outcome<T> = { state: "pending" };
  promise.then(
    (value) => {
      outcome = { state: "resolved", value };
    },
    (reason) => {
      outcome = { state: "rejected", reason };
    },
  );
  return () => outcome;
}
