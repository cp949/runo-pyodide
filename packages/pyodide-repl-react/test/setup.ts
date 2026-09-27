/**
 * vitest `setupFiles`(jsdom 시험 전용). jsdom에는 xterm `open()`이 쓰는 `window.matchMedia`가 없어 스텁을 둔다
 * (없으면 `open()`이 `TypeError`를 던진다). `getContext`는 "Not implemented" 경고만 내므로 조용한 스텁으로 바꾼다.
 * node 환경 시험(`package-boundary.test.ts`)에서는 `window`가 없어 건너뛴다.
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
