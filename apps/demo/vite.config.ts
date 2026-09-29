import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { BROWSER_TARGET } from "../../browser-target.mts";

// SharedArrayBuffer(Ctrl+C·input())는 cross-origin isolated 페이지에서만 쓸 수 있다(ADR-0004).
// dev와 preview 둘 다에 걸어야 한다. 이전 구현은 dev에만 걸어 preview·빌드 산출물이 비격리였다.
const crossOriginIsolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  plugins: [react()],
  server: { headers: crossOriginIsolationHeaders },
  preview: { headers: crossOriginIsolationHeaders },
  // worker 파일(`src/*.worker.ts`)의 bare import(dom-bridge worker가 가져오는 `@cp949/runo-coincident/window/worker` 등)를 dev 서버
  // 시작 때 미리 찾아 최적화한다. 안 그러면 브라우저가 worker를 처음 요청할 때 "새 의존성 최적화 → 전체 다시 불러오기"가 일어나 e2e가
  // 도중에 리셋된다.
  optimizeDeps: { entries: ["index.html", "src/*.worker.ts"] },
  // 빌드 floor(ADR-0008).
  // - worker 파일은 module worker(es)다.
  // - top-level await 문법 자체는 쓸 수 있다. Chrome 89 미만은 지원하지 않으므로 쓰지 않는다(async IIFE로 감싼다, `check-escompat`가 강제).
  // - `format: "es"`를 쓰는 이유는 TLA가 아니라 module worker이기 때문이다.
  // - 기본 iife로도 현재 프로덕션 빌드는 성공한다(vite 8.3.1, rolldown 1.2.11 실측).
  // - 이전 실측에서는 정적 import를 쓰는 여러 worker 진입점이 iife 빌드에서 실패했다. 지금은 재현되지 않는다. 원인은 알 수 없음.
  build: { target: [...BROWSER_TARGET] },
  worker: { format: "es" },
});
