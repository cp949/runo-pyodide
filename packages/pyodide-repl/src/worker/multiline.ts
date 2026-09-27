/**
 * 개행이 든 제출 문자열을 top-level 문장 단위 chunk로 나누는 분할기 로더(RD-011, 02-console-core.md 5.2).
 * 본체는 multiline.py(`.py?raw`), 별도 namespace에서 실행해 사용자 globals를 오염시키지 않는다.
 */
import type { PyodideInterface } from "pyodide";
import type { PyProxy } from "pyodide/ffi";
import MULTILINE_SOURCE from "./multiline.py?raw";

/** chunk = `console.push()`에 순서대로 넣을 줄 목록(top-level 문장 하나). error가 있으면 chunks는 비어 있다. */
export type SplitPaste = (
  source: string,
  flags: number,
) => [error: string | undefined, chunks: string[][]];

/** 분할기 소스의 Python 파일명. 트레이스백에 새면 알아보기 위한 이름이다. */
export const MULTILINE_FILENAME = "<multiline>";

/** 세션마다 한 번 부른다. 동기 함수. */
export function loadSplitPaste(
  pyodide: Pick<PyodideInterface, "runPython" | "toPy">,
): SplitPaste {
  // 별도 namespace(빈 dict)에서 정의해 사용자 globals를 오염시키지 않는다.
  const namespace = pyodide.toPy({}) as PyProxy & {
    get(name: string): unknown;
  };
  pyodide.runPython(MULTILINE_SOURCE, {
    globals: namespace,
    filename: MULTILINE_FILENAME,
  });
  const splitPaste = namespace.get("split_paste") as SplitPaste;
  namespace.destroy();
  return splitPaste;
}
