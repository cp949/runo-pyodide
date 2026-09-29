export interface Highlighter {
  // 현재 줄과 커서 위치를 받아 하이라이트된 버전을 돌려준다.
  highlight(line: string, pos: number): string;

  // 프롬프트를 받아 하이라이트된 버전을 돌려준다.
  highlightPrompt(prompt: string): string;

  // 커서 위치의 문자를 하이라이트해야 하면 true를 돌려준다.
  // 삽입이나 문자 이동 중 갱신을 최적화하는 데 쓴다.
  highlightChar(line: string, pos: number): boolean;
}

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
