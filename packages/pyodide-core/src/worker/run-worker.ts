/**
 * worker 쪽 진입점(`runWorker({ driver, plugins? })`). 앱의 얇은 worker 파일이 driver를 골라 부른다. main이 보낸 초기화 프레임을 받아
 * 검증한 뒤 CDN 로더를 주입해 부팅 시퀀스(`bootWorker`)를 시작한다. 프레임 수신은 이 모듈이 평가될 때(worker 전역이면)
 * 걸리는 수신기(`init-receiver.ts`)가 맡아, `runWorker`를 늦게 불러도(파일 안의 `await` 뒤 등) 프레임을 잃지 않는다. 전제는 이 모듈이
 * top-level await가 있는 모듈의 import보다 앞선 정적 import인 것이다(dom-bridge를 쓰면 dom-bridge `./worker` 다음): Vite 번들은
 * 모듈 코드를 import 순서대로 이어 붙여, top-level await 모듈이 먼저면 아래 수신기 문장이 그 `await` 뒤에 놓인다(01-protocols.md 4절).
 */
import { bootWorker } from "./boot";
import type { WorkerDriver } from "./driver";
import {
  createInitReceiver,
  isWorkerGlobalScope,
  type InitReceiver,
} from "./init-receiver";
import { loadPyodideFromCdn } from "./load-pyodide";
import type { WorkerPlugin } from "./plugin";

export interface RunWorkerOptions {
  driver: WorkerDriver;
  /** 부팅 중 `loadPyodide` 뒤·콘솔 생성 앞에서 배열 순서대로 하나씩 준비한다(`WorkerPlugin`). */
  plugins?: readonly WorkerPlugin[];
}

/**
 * 모듈 평가 시점의 수신기(최상위 문장이라 이 모듈을 import하는 순간 걸린다. core `./worker`에서 `runWorker` 없이 `bootWorker` 등만 import해도 걸린다). worker 전역이 아니면 만들지 않고 `runWorker`가
 * 호출될 때 만든다(jsdom·node 시험). 번들에서 이 문장이 빠지면 늦은 `runWorker`가 프레임을 잃는다. 상시 검사는 없다: 번들 결과에
 * 이 수신기가 남는지는 RD-023 DELTA-02에서 demo 프로덕션 빌드로 한 번 손으로 확인했을 뿐이다
 * (`_works/_completed/20260925-32-rd-023-dom-bridge/verify/delta02/bundle-static-check.log`).
 */
const moduleReceiver: InitReceiver | undefined = isWorkerGlobalScope()
  ? createInitReceiver(self)
  : undefined;

/**
 * init 프레임이 오면(이미 와 있으면 즉시) 검증된 프레임으로 부팅한다. `runWorker`는 worker당 한 번만 부를 수 있다: 두 번째
 * 호출은 던진다(같은 프레임으로 두 번 부팅하지 않는다). worker 전역이 아니면 호출마다 자기 수신기를 만든다(시험용).
 */
export function runWorker(options: RunWorkerOptions): void {
  const receiver = moduleReceiver ?? createInitReceiver(self);
  receiver.take((frame) => {
    // 부팅 중 예상하지 못한 예외가 처리되지 않은 rejection으로 새지 않게 남긴다.
    bootWorker(frame, {
      driver: options.driver,
      loadPyodide: loadPyodideFromCdn,
      plugins: options.plugins,
    }).catch((error: unknown) => {
      console.error("[worker] 부팅 시퀀스 예외", error);
    });
  });
}
