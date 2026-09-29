/**
 * worker 커널(`runWorker`)과 driver의 경계.
 *
 * 커널이 소유하는 순서. 괄호는 driver가 채우는 단계다.
 * - RPC 생성
 * - pyodide 로드(interrupt 공개 API 확인)
 * - 플러그인 `prepare`
 * - (driver 콘솔)
 * - (driver probe)
 * - 런타임 연결(`attachRuntime`, 03-ctrl-c.md 2.6)
 * - `ready`
 * - 감시 타이머 시작
 * - (driver 실행)
 *
 * driver는 콘솔 확장과 세션 제어 흐름만 낸다.
 * 이 모양은 REPL(`replDriver`, RD-020)과 실행 driver(`runDriver`, RD-022)가 쓰는 것만 담는다.
 * 공개 API로 문서화하기 전의 내부 계약이다.
 */
import type { PyodideInterface } from "pyodide";
import type { InitFrame } from "../protocol/init-frame";
import type { Rpc, RpcHandlers } from "../protocol/rpc";
import type { ConsoleSinks, PyodideConsoleProxy } from "./core-console";

/** `createConsole` 단계에서 driver가 받는 것. pyodide는 로드된 상태이고 콘솔은 아직 없다. */
export interface ConsoleContext {
  /** 로드된 pyodide */
  pyodide: PyodideInterface;

  /** `write`·`writeErrorRaw` RPC 알림에 연결된 sink. 전역 Writer와 콘솔 콜백이 같이 쓴다. */
  sinks: ConsoleSinks;

  /** 검증된 초기화 프레임. driver 옵션은 `frame.driver`가 아니라 `parseOptions`가 돌려준 값(`createSession`이 받았다)을 쓴다. */
  frame: InitFrame;
}

/** `run` 단계에서 driver가 받는 것. `ready` 알림은 이미 나갔다. */
export interface RunContext {
  /** 로드된 pyodide */
  pyodide: PyodideInterface;

  /** `createConsole`이 돌려준 콘솔 */
  pyconsole: PyodideConsoleProxy;

  /** main과 잇는 RPC 끝점 */
  rpc: Rpc;

  /** 검증된 초기화 프레임 */
  frame: InitFrame;
}

/** `probe` 단계에서 driver가 받는 것. 콘솔이 막 만들어진 상태다. webloop 억제·Ctrl+C 연결·stdin 배선은 아직이다. */
export interface ProbeContext {
  /** 로드된 pyodide */
  pyodide: PyodideInterface;

  /** `createConsole`이 돌려준 콘솔 */
  pyconsole: PyodideConsoleProxy;
}

/** worker(= 세션) 한 개의 driver 상태. 세션 상태는 클로저에 둔다. */
export interface WorkerDriverSession {
  /**
   * main이 부를 수 있는 RPC 핸들러.
   * `createRpc` 생성 시에만 받을 수 있다(늦은 등록 API 없음).
   * 콘솔이 생기기 전에도 유효해야 한다.
   * core 핸들러와 이름이 겹치면 생성 시 예외(`composeRpcHandlers`).
   */
  handlers: RpcHandlers;

  /**
   * 콘솔을 만든다.
   * - 핵심 두 단계 `installStdioWriters`·`createCoreConsole`은 core가 함수로 제공한다.
   * - driver가 이 안에서 두 함수를 부르고, 그 사이·뒤에 driver 단계를 끼운다.
   * - 순서를 core 부팅이 소유하지 않는 이유는 02-console-core.md 5.1.
   *
   * 던지면 `loadFailed`다.
   */
  createConsole(context: ConsoleContext): PyodideConsoleProxy;

  /**
   * driver가 기대하는 pyodide 비공개 API 지점을 콘솔 생성 직후 한 번 탐지한다(RD-021).
   * 기대와 다른 지점의 식별자를 돌려주면 core가 자기 지점 결과와 합쳐 `ready` 페이로드의 `degraded`로 알린다(빈 배열 = 문제 없음).
   * 선택 메서드다. 탐지할 지점이 없는 driver는 구현하지 않는다.
   * 던지면 `loadFailed`다.
   * 콘솔·전역 상태를 바꾸지 않아야 한다.
   */
  probe?(context: ProbeContext): string[];

  /**
   * `ready` 알림 뒤의 세션 제어 흐름. 끝나면 세션이 끝난 것이다(감시 타이머 정지). 던지면 `crashed`다.
   * REPL은 여기서 배너·러너를 만들고 `readLine` 루프를 돈다.
   */
  run(context: RunContext): Promise<void>;

  /** 감시 타이머의 프롬프트 유휴 폐기 판정(03-ctrl-c.md 2.5). driver가 "지금 대상 Python 코드가 없다"고 볼 때 참. */
  atPrompt(): boolean;
}

/**
 * `runWorker({ driver })`가 받는 driver. worker 하나에 세션 하나를 만든다.
 *
 * 초기화 프레임의 `driver` 필드(`unknown`)는 core가 모양을 모른다.
 * 커널이 `parseOptions(frame.driver)`로 driver에 검증을 맡기고, 통과한 값으로 `createSession(options)`을 부른다.
 * `parseOptions`가 던지면 세션 생성·RPC 생성·pyodide 로드를 시작하지 않는다.
 * 부팅이 그 오류로 거부된다(`runWorker`가 `console.error`로 남긴다).
 */
export interface WorkerDriver<Options = unknown> {
  /** 프레임의 `driver` 필드를 검증해 옵션으로 만든다. 모양이 틀리면 던진다. */
  parseOptions(raw: unknown): Options;

  /** 검증된 옵션으로 세션 하나를 만든다. worker당 한 번 부른다. */
  createSession(options: Options): WorkerDriverSession;
}
