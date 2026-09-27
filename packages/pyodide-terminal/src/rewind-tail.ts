/**
 * 꼬리 행 정리(04-stdin-input.md 3.3, TRP-016). 직전 출력의 꼬리를 프롬프트로 다시 그리려면 커서가 꼬리의 첫 행에
 * 있어야 한다. `Readline.read()`는 시작 시점의 커서 행을 프롬프트가 시작하는 행으로 잡고 첫 재그리기가 그 행만 열 0부터
 * 지운다(`\r\x1b[J`). 꼬리가 터미널 폭을 넘어 여러 행이면 커서는 마지막 행에 있어 앞 행이 남은 채 꼬리 전체가 다시
 * 그려져 앞 행이 중복된다. 그래서 읽기 전에 첫 행까지 커서를 올린다.
 * 행 수는 꼬리 텍스트가 아니라 화면 버퍼에서 센다: xterm이 실제로 감은(wrapped) 행이라 탭·전각 문자의 폭 차이로 어긋나
 * 위 행을 지우는 일이 없다. 다만 wrapped 행은 `\r` 뒤에서 시작한 꼬리의 윗부분까지 셀 수 있어(긴 줄 뒤 `\r`과 짧은
 * 텍스트) 그 위 행이 지워질 수 있다(알려진 한계). REPL 읽기와 stdin 읽기가 `promptRow.read`(RD-027)에서 같은 정리를 쓴다.
 */
import type { Terminal } from "@xterm/xterm";

export type RewindTerminal = Pick<Terminal, "cols" | "write" | "buffer">;

/**
 * 꼬리가 여러 행으로 감겼으면 read() 앞에 `\x1b[nA`로 첫 행까지 커서를 올린다(TRP-016).
 * 빈 꼬리와 짧은 꼬리(`tail.length * 2 < term.cols`)는 flush 없이 즉시 돌아온다.
 * 행 수는 `term.write("", cb)` flush 뒤 `buffer.active`의 커서 행(`baseY + cursorY`)부터 위로
 * `isWrapped`인 동안, 최대 `cursorY`까지 센다(뷰포트 위 스크롤백으로는 올리지 않는다).
 * 커서만 옮기므로 sink를 거치지 않는다(꼬리 추적에 넣을 텍스트가 없다).
 * 올린 행 수를 돌려준다(올리지 않았으면 0). 열은 그대로라 같은 수만큼 내리면 꼬리 끝(되감기 전 커서)으로 돌아간다.
 */
export async function rewindTail(
  term: RewindTerminal,
  tail: string,
): Promise<number> {
  // 폭 2칸 문자로만 채워도 한 행을 넘지 못하는 짧은 꼬리는 화면 버퍼를 볼 필요가 없다(이스케이프가 길이를 부풀리므로
  // 보수적인 검사다).
  if (tail === "" || tail.length * 2 < term.cols) return 0;
  // 방금 쓴 출력은 xterm이 나중에(쓰기 순서대로) 파싱한다. flush를 기다려야 화면 버퍼가 꼬리 끝(커서)을 반영한다.
  await new Promise<void>((resolve) => {
    term.write("", resolve);
  });
  const buffer = term.buffer.active;
  let row = buffer.baseY + buffer.cursorY;
  let up = 0;
  // 커서 행이 윗 행에서 이어진 행이면 그 줄의 첫 행까지 센다. 뷰포트 위(스크롤백)로는 올릴 수 없어 cursorY까지만 센다.
  while (up < buffer.cursorY && buffer.getLine(row)?.isWrapped) {
    up += 1;
    row -= 1;
  }
  if (up > 0) term.write(`\x1b[${up}A`);
  return up;
}
