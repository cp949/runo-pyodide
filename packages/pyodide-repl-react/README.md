# @cp949/runo-pyodide-repl-react

`@cp949/runo-pyodide-core`·`-terminal`·`-repl`을 React 컴포넌트(`PythonRunner`·`PythonRepl`)와 hook(`usePythonRunner`)으로 감싸는 패키지. private이며 배포는 `pnpm pack` tarball이다(`pnpm smoke:pack`이 설치·import·타입 해석을 확인한다). coincident에 의존하지 않는다(`test/package-boundary.test.ts`). 규칙 본문은 `docs/design/15-react.md`.

## 진입점

| export                   | 내용                                                                                                                                                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PythonRunner`           | terminal `createTerminalRunner`를 감싼 `python main.py` 방식 실행창. handle `run`·`stop`·`reset`·`clear`·`setCopyOnSelect`·`focus`·`status`                                                                                                                                                 |
| `PythonRepl`             | repl `createRepl`을 감싼 REPL. handle `runSource`·`reset(options?)`·`setCopyOnSelect`·`focus`·`busy`·`crossOriginIsolated`                                                                                                                                                                  |
| `usePythonRunner`        | xterm 없이 core `createRunner`를 React 수명에 붙이는 hook. `{ status, run, stop, reset, interrupt, busy }`                                                                                                                                                                                  |
| `RunRejectedError`, 타입 | core의 `RunRejectedError`(같은 클래스)와 `PythonRunnerProps`·`PythonRunnerHandle`·`PythonReplProps`·`PythonReplHandle`·`UsePythonRunnerOptions`·`UsePythonRunnerResult`·`InputProvider`·`OutputChunk`·`RunRejectedReason`·`RunResult`·`RunnerStatus`·`StopResult`·`ReplStatus`·`CopyResult` |

서브패스는 없다. React 19 ref-as-prop이다(`ref` prop, `forwardRef` 없음).

## 의존

- dependencies: `@cp949/runo-pyodide-core`·`-terminal`·`-repl`(`workspace:*`), `@xterm/addon-fit`(0.11.0)
- peerDependencies: `react`·`react-dom`(`^19.0.0`), `@xterm/xterm`(`^6.0.0`)
- `xterm.css`는 패키지가 import하지 않는다. 소비자가 `@xterm/xterm/css/xterm.css`를 import한다.

## 사용

앱이 worker 파일을 조립한다. Vite `worker.format`은 `'es'`여야 하고, 페이지는 cross-origin isolated여야 한다(COOP `same-origin` + COEP `require-corp`, dev·preview·배포 모두). 아니면 worker를 만들지 않고 상태 `not-isolated`가 된다.

```ts
// runner.worker.ts
import { runDriver, runWorker } from "@cp949/runo-pyodide-core/worker";
runWorker({ driver: runDriver });

// repl.worker.ts
import { runReplWorker } from "@cp949/runo-pyodide-repl/worker";
runReplWorker();
```

```tsx
import {
  PythonRunner,
  type PythonRunnerHandle,
} from "@cp949/runo-pyodide-repl-react";
import "@xterm/xterm/css/xterm.css";
import { useRef } from "react";

const createWorker = () =>
  new Worker(new URL("./runner.worker.ts", import.meta.url), {
    type: "module",
  });

export function App() {
  const ref = useRef<PythonRunnerHandle>(null);
  return (
    <>
      <button onClick={() => ref.current?.run('print("hi")')}>run</button>
      <PythonRunner
        ref={ref}
        createWorker={createWorker}
        style={{ height: 360 }}
      />
    </>
  );
}
```

`PythonRepl`은 `createWorker`가 `repl.worker.ts`를 가리키고 handle이 `runSource`·`reset`이라는 점만 다르다.

- 컴포넌트는 콜백(`onStatus`·`onOutput`·`onCrash`·`onCopy`·`inputProvider`)을 항상 최신 함수로 부른다(인라인 람다여도 재마운트 없음). `copyOnSelect`만 재렌더로 바뀐다. `createWorker`·`indexURL`·`filename`·`topLevelAwait`·`clearOnRun`·`terminalOptions`·`fit`은 마운트 때만 읽는다(바꾸려면 `key`로 재마운트).
- `fit`(기본 `true`)은 컨테이너 크기를 따른다. 컨테이너 높이가 0이거나 `display: none`이면 건너뛴다. 80×24 고정이면 `fit={false}`.
- StrictMode(dev)에서는 worker가 2개 만들어지고 1개가 terminate된다. 첫 worker의 pyodide 로드는 낭비로 수용한다.
- worker 파일이 `@cp949/runo-pyodide-core/worker`를 import하면 그 타입 때문에 `pyodide`(+`@types/node`·`@types/emscripten`)가 필요하다(`packages/pyodide-core/README.md`).
- 지원하지 않는 것: iframecall 어댑터, xterm `Terminal` 객체 노출, 생성 옵션의 런타임 변경, `autoFocus`, `PythonRunner`의 `interrupt`·`busy`(`docs/design/15-react.md` 15.9).

## 시험

`pnpm --filter @cp949/runo-pyodide-repl-react test`(jsdom + 가짜 `Worker` + 실제 core·xterm). 브라우저 확인은 `pnpm --filter demo e2e:react-strictmode`(StrictMode worker 수)·`e2e:react-fit`(`?fit=1` 리사이즈), 화면 이전 회귀는 `e2e:runner-check`·`e2e:repl-check` 등(`apps/demo/e2e/BASELINE.md`).
