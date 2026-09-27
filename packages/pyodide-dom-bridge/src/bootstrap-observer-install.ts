/**
 * 부트스트랩 관찰기를 worker 전역에 설치하는 부수효과 모듈. `worker.ts`가 `coincident/window/worker`보다 **먼저** import한다: 관찰
 * 리스너가 coincident의 부트스트랩 리스너보다 먼저 등록돼야 메시지를 볼 수 있다(등록 순서가 성립 조건, `bootstrap-observer.ts`).
 * ESM은 import 순서대로 평가하지만 번들러는 외부 import(`coincident/window/worker`)를 파일 맨 위로 올리므로, 이 모듈을 별도 진입점
 * (`tsdown.config.ts`)으로 두어 dist에서 별도 파일로 남긴다. 두 진입점(`worker`·`bootstrap-observer-install`)이 이 모듈을 공유하므로
 * 실제 본문은 해시 청크(`dist/bootstrap-observer-install-<hash>.mjs`)에 들어가고, `dist/worker.mjs`는 그 해시 청크를 coincident보다
 * 먼저 import한다(`scripts/check-dist.mjs --allow-sync-bridge`가 순서를 검사한다). `dist/bootstrap-observer-install.mjs`는 해시 청크를
 * 다시 내보내는 스텁이다. 그래서 `package.json` `sideEffects`는 이 파일 이름만이 아니라 글로브(`./dist/bootstrap-observer-install*.mjs`)로
 * 해시 청크까지 덮어야 부수효과 전용 import에서 관찰기가 사라지지 않는다.
 */
import { createBootstrapObserver } from "./bootstrap-observer";

/** 지금 전역이 worker 전역인가. 아니면(jsdom·node 시험) 모듈 평가 때 리스너를 걸지 않는다. */
function isWorkerGlobalScope(): boolean {
  const scope = (globalThis as { WorkerGlobalScope?: unknown })
    .WorkerGlobalScope;
  return typeof scope === "function" && globalThis instanceof scope;
}

// 모듈 평가 시점에 건다(`prepare`가 아니라). 부트스트랩은 이 시점 이후에만 볼 수 있다.
export const observer = isWorkerGlobalScope()
  ? createBootstrapObserver(self)
  : undefined;
