/**
 * REPL driver 옵션(초기화 프레임 `driver` 필드의 내용, 01-protocols.md 4절). main 쪽 driver가 싣고 worker 쪽 driver가
 * 검증한다. core는 이 모양을 모른다(`InitFrame.driver: unknown`). 두 쪽이 같은 타입·파서를 쓰도록 main·worker 어느 쪽도
 * 아닌 이 모듈에 둔다(core 의존 없음).
 */
export interface ReplDriverOptions {
  /** 콘솔 생성 직후 한 번만 적용한다(02-console-core.md 5.4). 바꾸려면 새 세션(`reset({ topLevelAwait })`). */
  topLevelAwait: boolean;
}

/** worker가 받은 `frame.driver`를 검증한다. 모양이 틀리면 어느 필드가 왜 틀렸는지 담은 오류를 던진다. */
export function parseReplDriverOptions(raw: unknown): ReplDriverOptions {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("REPL driver 옵션 오류 — driver: 객체 필요");
  }
  const { topLevelAwait } = raw as { topLevelAwait?: unknown };
  if (typeof topLevelAwait !== "boolean") {
    throw new Error("REPL driver 옵션 오류 — topLevelAwait: boolean 필요");
  }
  return { topLevelAwait };
}
