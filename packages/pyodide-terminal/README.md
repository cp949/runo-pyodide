# @cp949/runo-pyodide-terminal

xterm.js 터미널에 붙는 Python 실행창 `createTerminalRunner`와, `@cp949/runo-pyodide-repl`이 공유하는 xterm 결합 부품 5종. core(`@cp949/runo-pyodide-core`) 위에 얹힌다. coincident에 의존하지 않는다. private이고 공개 API로 확정하지 않은 내부 계약이다. 배포는 `pnpm pack` tarball이다(`pnpm smoke:pack`이 tarball 설치·import·타입 해석을 확인한다).

## 진입점

| 진입점                                  | 내용                                                                                                                                                                                                    | 안정성                                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `@cp949/runo-pyodide-terminal`          | `createTerminalRunner`, `RunRejectedError`, 타입(`TerminalRunnerOptions`·`TerminalRunnerHandle`·`InputProvider`·`OutputChunk`·`RunResult`·`RunnerStatus`·`StopResult`·`RunRejectedReason`·`CopyResult`) | 앱 코드가 쓰는 표면                                                                                       |
| `@cp949/runo-pyodide-terminal/internal` | `sinks`·`rewind-tail`·`selection-copy`·`surface`·`prompt-row`의 모든 export                                                                                                                             | **repl 전용. 안정성 보장 없음. 두 패키지가 lockstep으로 함께 바뀐다.** 이름·모양이 예고 없이 바뀔 수 있다 |

`./internal`을 repl 밖에서 import하지 않는다. repl이 terminal에 의존하고 terminal은 repl에 의존하지 않는다(단방향, `test/package-boundary.test.ts`).

## 사용

앱은 worker 파일에서 core 실행 driver를 쓴다. Vite `worker.format`은 `'es'`여야 한다.

```ts
// runner.worker.ts
import { runDriver, runWorker } from "@cp949/runo-pyodide-core/worker";
runWorker({ driver: runDriver });
```

```ts
import {
  createTerminalRunner,
  RunRejectedError,
} from "@cp949/runo-pyodide-terminal";

const runner = createTerminalRunner({
  terminal, // 호출자가 만들고 dispose한다(xterm Terminal)
  createWorker: () =>
    new Worker(new URL("./runner.worker.ts", import.meta.url), {
      type: "module",
    }),
  onStatus: (status) => {}, // "loading" | "ready" | "running" | "waiting-input" | "restarting" | "load-failed" | "crashed" | "not-isolated"
});

try {
  const result = await runner.run('name = input("이름: ")\nprint(name)');
  // { kind: "ok" } | { kind: "error", errorType, traceback } | { kind: "interrupted", traceback }
  // | { kind: "exit", code } | { kind: "restarted" }
} catch (error) {
  if (error instanceof RunRejectedError) error.reason; // "busy" | "unavailable" | "disposed" | "crashed"
}

await runner.stop(); // "idle" | "stopped" | "restarted"
runner.dispose(); // Terminal은 dispose하지 않는다
```

- 페이지가 cross-origin isolated여야 한다(COOP/COEP). 아니면 worker를 만들지 않고 안내 한 줄 + 상태 `not-isolated`이며 `run()`은 `unavailable`이다.
- 실행창은 `input()` 대기 중에만 한 줄 입력을 받는다. 그 밖의 키·붙여넣기는 버린다. Ctrl+C는 상태(선택 복사 / `running` 인터럽트 / 입력 취소 / 무동작)로 갈린다.
- `inputProvider`를 주면 xterm 입력 대신 그 함수가 `input()`을 받는다. 생략하면 xterm에서 한 줄을 읽는다.
- 상태·결과·`stop()` 1000ms 폴백·`InputProvider` 계약·키 정책은 `docs/design/14-runner.md`.

## 시험

`pnpm --filter @cp949/runo-pyodide-terminal test`(jsdom + 가짜 터미널 + 실제 core + 공용 가짜 worker). 브라우저 확인은 `pnpm --filter demo e2e:runner-check`.
