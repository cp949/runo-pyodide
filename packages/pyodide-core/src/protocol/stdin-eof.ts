/**
 * 입력 끝(EOF) 표식. 규칙은 `docs/design/01-protocols.md` 2절.
 * - `MainDriver.readInput`·`InputProvider`가 입력 끝을 알릴 때 돌려주는 main 쪽 값이다.
 * - core 세션(`session/core-session.ts`)의 `readInput` 핸들러가 이 값을 보면 `mailboxWriter.eof()`를 부른다.
 * - 벤더 `READ_EOF`(`@cp949/runo-xterm-readline`)와는 다른 값이다. terminal 계층이 변환한다.
 */
export const STDIN_EOF: unique symbol = Symbol("STDIN_EOF");
