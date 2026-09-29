/**
 * vitest `setupFiles`. jsdom 시험 전용이다.
 * - `window.matchMedia`: jsdom에 없다. xterm `open()`이 쓰므로 스텁을 둔다. 없으면 `open()`이 `TypeError`를 던진다.
 * - `HTMLCanvasElement.prototype.getContext`: jsdom은 "Not implemented" 경고만 낸다. `null`을 돌려주는 스텁으로 조용히 만든다.
 * - node 환경 시험(`package-boundary.test.ts`, `use-lifecycle-unsupported.test.ts`)은 `window`가 없어 건너뛴다.
 */
if (typeof window !== "undefined") {
  if (typeof window.matchMedia !== "function") {
    window.matchMedia = (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList;
  }
  HTMLCanvasElement.prototype.getContext = () => null;
}
