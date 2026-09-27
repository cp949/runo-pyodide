/**
 * REPL의 `readLine` RPC에서 main과 worker가 공유하는 형식(01-protocols.md). worker 루프가 요청을 보내고 main이 열린 읽기의 응답을
 * 돌려주는 하나의 왕복이다. 두 쪽이 같은 타입을 쓰도록 main·worker 어느 쪽도 아닌 이 모듈에 둔다(값은 없고 타입과 판별 함수뿐이다).
 *
 * 요청: `readLine(prompt, pending, cancelable, outcome?)` — 네 번째 인자 `outcome`은 바로 앞 `{ source }` 응답으로 실행한
 * 코드(`runSource`)의 결말이다. 그 실행이 없었던 요청에는 인자 자체를 싣지 않는다(기존 3인자 요청과 같은 모양).
 * 응답: 줄 문자열(제출), `null`(입력 취소), `{ source }`(루프 명령: 이 코드를 REPL에서 실행하라), `{ eof: true }`(`>>>` 읽기의
 * 빈 줄 Ctrl+D — 세션 종료, RD-048).
 */
import type { RunOutcome } from "@cp949/runo-pyodide-core";

/** 루프 명령. main이 열린 `readLine` 요청에 줄 대신 보내면 worker 루프가 제출 한 건처럼 받아 REPL 콘솔에서 실행한다. */
export interface ReadLineSourceReply {
  source: string;
}

/**
 * `readLine` 요청이 EOF로 끝났다(`>>>`만 — `pending === undefined`인 요청에만 켠 `eof: true` 읽기의 빈 줄 Ctrl+D, RD-048).
 * worker 루프는 `run`을 부르지 않고 `onTerminated()`로 세션을 끝낸다.
 */
export interface ReadLineEofReply {
  eof: true;
}

/** `readLine` 요청에 대한 응답. */
export type ReadLineReply =
  string | null | ReadLineSourceReply | ReadLineEofReply;

/**
 * `{ source }` 실행의 결말(`readLine` 요청의 네 번째 인자). core 결과 유니온 `RunOutcome`과 같다(`ok`·`error`·`interrupted`·`exit`).
 * `restarted`는 main이 만드는 결말이라 여기에 없다. worker 내부 오류는 `error{ errorType: "InternalError" }`로 실린다.
 */
export type ReadLineOutcome = RunOutcome;

/** 응답이 루프 명령 `{ source }`인가. */
export function isReadLineSourceReply(
  reply: ReadLineReply,
): reply is ReadLineSourceReply {
  return typeof reply === "object" && reply !== null && "source" in reply;
}

/** 응답이 EOF `{ eof: true }`인가. */
export function isReadLineEofReply(
  reply: ReadLineReply,
): reply is ReadLineEofReply {
  return typeof reply === "object" && reply !== null && "eof" in reply;
}
