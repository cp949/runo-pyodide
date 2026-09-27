# TRP-055 가짜 터미널·벤더 `Readline`에 `\n`(LF)을 넣으면 줄바꿈이 되지 않고 버려진다

- 상태: ACTIVE
- 적용 조건: `packages/pyodide-testkit`의 가짜 터미널 `paste(text)`·`type(text)`나 벤더 `Readline`의 `onData` 경로에 개행이 든 문자열을 넣어 여러 행 버퍼·여러 줄 제출을 만드는 시험.

## 오해하기 쉬운 신호

- 예외가 없다. `paste("pri\nnt")` 뒤 입력줄이 두 행이 아니라 한 행 `print`다.
- "여러 행이다"를 단정하지 않는 시험(거부·복원·재그리기 동작)은 잘못된 전제(단일 행 버퍼)로 통과한다. 행 수를 단정하는 시험에서만 드러난다.

## 원인

벤더 `parseInput`(`keymap.ts`)은 0x20 미만 문자를 제어 문자 토큰으로 나누고 `\r`(0x0d)만 `Enter`로 해석한다. `\n`(0x0a)은 `UnsupportedControlChar`이고 `readPaste`도 `Enter`·`\t`만 텍스트로 승격하며 `readKey`는 `UnsupportedControlChar`를 무시한다. 그래서 `"pri\nnt"`는 `pri` + 무시 + `nt`가 되어 이어 붙는다. 실제 xterm의 붙여넣기는 개행을 `\r`로 바꿔 `onData`에 넘기므로 브라우저에서는 이 증상이 없다.

## 탐지/회피

- 개행이 든 붙여넣기는 `\r`로 넣는다(`paste("pri\rnt")`). 여러 행 버퍼는 `type("pri")` → `keyDown({ key: "Enter", shiftKey: true })` → `type("nt")`(Shift+Enter 경로)로도 만든다.
- 여러 행 전제에 의존하는 시험은 만든 버퍼의 행 수를 먼저 단정한다.
