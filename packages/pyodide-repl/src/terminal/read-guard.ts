/**
 * REPL 읽기(`readLine` 요청)와 stdin 읽기(`readInput` 알림)는 같은 `Readline`을 쓴다.
 * `readline.read()`는 이미 열린 읽기를 교체하고 옛 읽기의 promise를 끝내지 않는다.
 * 프롬프트를 기다리는 동안 worker에서 도는 배경 콜백이 `input()`을 부르면 stdin 읽기가 REPL 읽기를 교체한다.
 * 그러면 사용자가 친 REPL 줄이 stdin으로 가고 `readLine` 응답이 오지 않아 이후 입력이 멈춘다(04-stdin-input.md 3.2).
 * 그래서 stdin 읽기는 활성 REPL 읽기의 결과가 정해진 뒤에 시작한다.
 *
 * - 교착 없음: worker는 stdin 읽기 동안 동기 대기한다. REPL 응답은 포트에 큐잉된다(01-protocols.md 1.3).
 *   REPL 줄이 끝난 뒤 stdin 읽기가 끝나 콜백이 돌아가면 worker가 그 응답을 처리한다.
 * - REPL 읽기는 기다리지 않고 바로 부른다(시작 타이밍 불변). stdin 읽기끼리는 직렬화하지 않는다.
 *   worker가 동기 대기라 두 stdin 읽기가 겹치지 않는다.
 * - REPL 읽기가 줄·취소·실패 어느 쪽으로 끝나도 stdin 읽기는 진행한다. 실패는 원본 promise 그대로 REPL 호출자에게 간다.
 *   예외: 그사이 세션이 끝났으면 열지 않는다(규칙: `docs/design/08-session.md` 8.1 D6).
 * - 겹침 거절(`repl-main-driver.ts`의 읽기 phase)은 가드 바깥에서 검사한다. 거절된 요청을 가드가 추적하면 실제 활성 REPL 읽기를 잃어
 *   stdin 읽기가 앞당겨진다.
 * - stdin 읽기를 미루는 순간(`readInput` 도착, 동기) `promptRow.detachPrefix()`로 접두를 뗀다(RD-022b).
 *   배경 `input()`이 먼저 쓴 프롬프트는 열린 REPL 읽기의 접두가 되어 있다.
 *   REPL 줄이 끝나 벤더가 접두를 잊기 전에 그것을 꼬리로 옮겨 stdin 읽기의 프롬프트로 쓴다.
 * - 미룬 읽기를 D6으로 열지 않으면 뗀 핸들의 `draw()`를 불러 뗀 조각을 그린다(규칙: `docs/design/04-stdin-input.md` 3.2).
 */
import type { STDIN_EOF } from "@cp949/runo-pyodide-core";
import type {
  PromptReadOptions,
  PromptRow,
} from "@cp949/runo-pyodide-terminal/internal";

const ignore = () => {};

export interface ReadGuard {
  readLine(
    prompt: string,
    options: PromptReadOptions,
  ): Promise<string | null | typeof STDIN_EOF>;
  /** `sessionEnded`: 미룬 뒤 열기 직전 조회(규칙: `docs/design/08-session.md` 8.1 D6).
   * stdin 읽기는 항상 EOF를 켠다(`input()`·`sys.stdin` 읽기는 어디서나 EOF일 수 있다).
   * REPL `>>>`만 켜는 `readLine`과 다르다(RD-048). */
  readInput(
    cancelable: boolean,
    sessionEnded: () => boolean,
  ): Promise<string | null | typeof STDIN_EOF>;
}

/**
 * 돌려준 `readLine`은 반환 promise를 "활성 REPL 읽기"로 추적하고, `readInput`은 그 읽기가 끝난 뒤 `promptRow.read("")`를 부른다.
 * 목록 재그리기 등으로 읽기가 새로 시작돼도 `readLine`이 돌려주는 promise는 바뀌지 않는다. 그 promise가 최종 종료 시점이다.
 */
export function createReadGuard(
  promptRow: Pick<PromptRow, "read" | "detachPrefix">,
): ReadGuard {
  // 활성 REPL 읽기가 끝나면(줄·취소·실패 어느 쪽이든) 이행된다. 읽기가 없거나 끝났으면 이미 이행된 promise다.
  let replRead: Promise<void> = Promise.resolve();
  // 활성 REPL 읽기가 끝나지 않았다. 끝난 옛 읽기의 처리가 뒤에 열린 새 읽기의 표시를 내리지 않게 `replRead`와 대조한다.
  let replOpen = false;
  return {
    readLine(prompt, options) {
      const read = promptRow.read(prompt, options);
      // 가드 내부 체인만 실패를 삼킨다. 호출자가 받는 `read`는 그대로다.
      const settled = read.then(ignore, ignore);
      replRead = settled;
      replOpen = true;
      void settled.then(() => {
        if (replRead === settled) replOpen = false;
      });
      return read;
    },
    async readInput(cancelable, sessionEnded) {
      const deferred = replOpen;
      const detached = deferred ? promptRow.detachPrefix() : undefined;
      await replRead;
      // 규칙: `docs/design/08-session.md` 8.1 D6.
      if (sessionEnded()) {
        detached?.draw();
        return null;
      }
      // REPL `input()`은 history 기록을 유지한다(실행창과 다름 — `history: false`를 넣지 않는다).
      // 빈 줄 Ctrl+D는 EOF다(RD-048). core가 `STDIN_EOF`를 `input()`의 `EOFError`로 바꾼다.
      return promptRow.read("", { cancelable, eof: true });
    },
  };
}
