/**
 * jsdom에는 클립보드가 없다. `navigator.clipboard.writeText`를 대역으로 채워 복사 시험이 쓰게 한다(RD-043).
 * 원복하지 않는다(호출한 시험이 끝나면 페이지가 버려지는 현행 동작 그대로).
 */
import { vi, type Mock } from "vitest";

/** `navigator.clipboard.writeText` 대역을 심고 그 spy를 돌려준다. */
export function stubClipboard(): Mock<Clipboard["writeText"]> {
  const writeText = vi.fn<Clipboard["writeText"]>(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  return writeText;
}
