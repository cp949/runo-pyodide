// coincident 4.1.1은 TypeScript 선언을 배포하지 않는다. 이 패키지가 쓰는 표면만 선언한다: 진입점은 `coincident/window/main`
// (문서 쪽)과 `coincident/window/worker`(worker 쪽) 둘뿐이고(CSP 정적 검사가 강제한다, `scripts/check-dist.mjs`), 반환값에서
// 쓰는 필드만 적는다. worker 쪽 반환의 `ffi`(임의 코드 평가 등)·`transfer`·`isWindowProxy`는 선언하지 않아 쓸 수 없다.
// 형태는 coincident 소스(`src/window/main.js`·`src/window/worker.js`)로 확인했다.

declare module "coincident/window/main" {
  /** 문서 쪽에서 만드는 Worker. `proxy`에 문서 함수를 등록하면 worker가 `proxy.<name>(...)`으로 호출한다. */
  interface CoincidentMainWorker extends Worker {
    proxy: Record<string, unknown>;
  }

  interface CoincidentMainResult {
    /** 기본 `Worker`를 확장한 생성자. 만들 때 동기로 부트스트랩 메시지를 보낸다. */
    Worker: new (
      scriptURL: string | URL,
      options?: WorkerOptions,
    ) => CoincidentMainWorker;
    /** growable SharedArrayBuffer가 되는 환경인지. 모듈 평가 시점에 고정된다(옵션이 아니다). */
    native: boolean;
  }

  /** 옵션 없이 부른다(이 패키지는 서비스워커 등 옵션을 쓰지 않는다). */
  export default function coincident(): CoincidentMainResult;
}

declare module "coincident/window/worker" {
  interface CoincidentWorkerResult {
    /** main이 `worker.proxy`에 등록한 함수들. `native`면 동기 호출이다. */
    proxy: Record<string, unknown>;
    /** growable SharedArrayBuffer가 되는 환경인지. `false`면 동기 DOM 호출이 무효가 된다. */
    native: boolean;
    /** main `window`의 원격 프록시. */
    window: Window & typeof globalThis;
  }

  /** 부트스트랩 메시지가 오면 풀린다. 놓치면 영원히 대기한다. 옵션 없이 한 번만 부른다. */
  export default function coincident(): Promise<CoincidentWorkerResult>;
}
