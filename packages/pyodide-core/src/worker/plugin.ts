/**
 * worker 플러그인 계약(RD-023). 앱의 worker 파일이 `runWorker({ driver, plugins })`로 넘기면 부팅 시퀀스가 `loadPyodide`와
 * interrupt 공개 API 확인 뒤, 콘솔 생성 앞에서 배열 순서대로 하나씩 `prepare`를 await한다(`bootWorker`). 비동기 준비(예:
 * `await` 동기 브리지 초기화 뒤 `pyodide.registerJsModule`)를 부팅 안에서 마치는 자리다. 해제 훅은 없다(worker는 terminate로 끝난다).
 */
import type { PyodideInterface } from "pyodide";

export interface PluginContext {
  pyodide: PyodideInterface;
}

export interface WorkerPlugin {
  /** 오류 문구의 접두(`plugin "<name>": `)에 쓰인다. */
  name: string;
  /**
   * 던지거나 reject하면 세션은 `loadFailed`(문구 접두 `plugin "<name>": `)로 끝난다. 앞 플러그인이 실패하면 뒤 플러그인은
   * 부르지 않는다.
   */
  prepare(context: PluginContext): void | Promise<void>;
}
