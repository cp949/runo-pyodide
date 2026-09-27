import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

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
  // worker 파일(`src/*.worker.ts`)의 bare import(dom-bridge worker가 가져오는 `coincident/window/worker` 등)를 dev 서버 시작 때 미리
  // 찾아 최적화한다. 안 그러면 브라우저가 worker를 처음 요청할 때 "새 의존성 최적화 → 전체 다시 불러오기"가 일어나 e2e가 도중에 리셋된다.
  optimizeDeps: { entries: ["index.html", "src/*.worker.ts"] },
  // worker 파일에 top-level await가 들어갈 수 있어 es여야 한다(기본 iife는 프로덕션 빌드에서 실패).
  worker: { format: "es" },
});
