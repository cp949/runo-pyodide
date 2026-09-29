/**
 * 강조(하이라이트) 훅.
 * `Readline.setHighlighter`로 등록한다. `Tty.refreshLine`이 다시 그릴 때마다 부른다.
 * 규칙은 docs/design/06-editing.md 6.1.
 */
export interface Highlighter {
  /** 현재 줄과 커서 위치를 받아 강조한 문자열을 돌려준다. */
  highlight(line: string, pos: number): string;

  /** 프롬프트를 받아 강조한 문자열을 돌려준다. */
  highlightPrompt(prompt: string): string;

  /**
   * 커서 위치의 문자를 강조해야 하면 참이다.
   * 삽입·커서 이동 중 전체 재그리기를 줄이는 데 쓴다(`State.shouldHighlight`).
   */
  highlightChar(line: string, pos: number): boolean;
}

/** 아무것도 강조하지 않는 기본 구현. 입력을 그대로 돌려준다. */
export class IdentityHighlighter implements Highlighter {
  highlight(line: string, pos: number): string {
    return line;
  }
  highlightPrompt(prompt: string): string {
    return prompt;
  }
  highlightChar(line: string, pos: number): boolean {
    return false;
  }
}
