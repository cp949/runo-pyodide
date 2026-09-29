/**
 * jsdom에는 클립보드가 없다. `navigator.clipboard.writeText`를 대역으로 채워 복사 시험이 쓰게 한다(RD-043).
 * 원복하지 않는다. 시험 파일이 끝나면 jsdom 페이지가 버려진다.
 */
import { vi, type Mock } from "vitest";

/** `navigator.clipboard.writeText` 대역을 심고 그 spy를 돌려준다. 대역은 항상 성공(resolve)한다. */
export function stubClipboard(): Mock<Clipboard["writeText"]> {
  const writeText = vi.fn<Clipboard["writeText"]>(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  return writeText;
}
