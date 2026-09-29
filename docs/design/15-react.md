# React 컴포넌트와 hook

> RD-024 신규 절이다. 이전 구현에 대응 기능이 없어 `12-previous-implementation.md`의 참고 경로가 없다. 이름·props·상태 문자열은 `packages/pyodide-repl-react/src/`의 export와 일치해야 한다. `apps/demo`(`ReplView`·`RunnerView`)와 `e2e:react-strictmode`·`e2e:react-fit`이 브라우저에서 확인한다. 결정 근거는 [ADR-0006](../adr/0006-pyodide-core-and-plugin-packages.md)의 "갱신(RD-024)".

## 15.1 구성과 패키지 배치

`@cp949/runo-pyodide-repl-react`(`packages/pyodide-repl-react`, private, 진입점 `.` 하나)는 core·terminal·repl의 핸들을 React 수명에 붙인다. 프로토콜·worker·줄 편집은 하위 패키지가 맡는다. 이 패키지는 xterm `Terminal` 생성·`FitAddon`·dispose 순서·StrictMode 이중 마운트·핸들 위임만 맡는다.

| export            | 하위 API                        | xterm | 내용                                                                                                                                                                                                                                                                                                                         |
| ----------------- | ------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PythonRunner`    | terminal `createTerminalRunner` | O     | `python main.py` 방식 실행창(`input()`만 한 줄 읽는다, 14.5)                                                                                                                                                                                                                                                                 |
| `PythonRepl`      | repl `createRepl`               | O     | 대화형 REPL(02~08)                                                                                                                                                                                                                                                                                                           |
| `usePythonRunner` | core `createRunner`             | X     | xterm 없이 runner를 React 수명에 붙인다(15.7)                                                                                                                                                                                                                                                                                |
| 타입·재수출       | —                               | —     | `PythonRunnerProps`·`PythonRunnerHandle`·`PythonReplProps`·`PythonReplHandle`·`UsePythonRunnerOptions`·`UsePythonRunnerResult`, `RunRejectedError`(core의 것, 같은 클래스), 타입 `InputProvider`·`OutputChunk`·`RunRejectedReason`·`RunResult`·`RunnerStatus`·`StopResult`(core), `ReplStatus`(repl), `CopyResult`(terminal) |

- 의존: `@cp949/runo-pyodide-core`·`-terminal`·`-repl`(`workspace:*`), `@xterm/addon-fit`(`0.11.0` 정확 고정). peer: `react`·`react-dom`(`^19.0.0`), `@xterm/xterm`(`^6.0.0`). `xterm.css`는 패키지가 import하지 않고 소비자가 `@xterm/xterm/css/xterm.css`를 import한다. coincident·reflected-ffi에 의존하지 않는다. 시험이 강제한다(`09-testing.md` 9.8).
- 소스 파일: `python-runner.tsx`·`python-repl.tsx`(컴포넌트), `use-python-runner.ts`(hook), `use-lifecycle.ts`(수명 공용: `useLatest`·`useCoreHandle`·`useRunnerDelegates`), `use-terminal-widget.ts`(터미널 위젯 수명: view 부착·하위 생성·실패 되돌리기·dispose 순서·`focus`·`copyOnSelect`, RD-038), `terminal-view.ts`(`Terminal` 생성·fit).
- React 19 ref-as-prop이다(`ref?: Ref<…Handle>`, `forwardRef` 없음). 컴포넌트는 컨테이너 `<div>`를 하나 렌더링한다. `className`·`style`·나머지 div 속성(예: `data-testid`)은 그 div에 그대로 넘긴다. 하위 옵션과 이름이 겹치는 div 속성(`onCopy` 등)은 하위 옵션이 우선한다.

## 15.2 props와 handle

props 타입은 하위 옵션 타입에서 `Omit`으로 유도한다. 어긋남을 컴파일 때 잡는다(타입 시험 `expectTypeOf`가 시그니처 동일성을 고정한다).

| prop                | `PythonRunner`                                      | `PythonRepl`      | 변경 시                                                                                       |
| ------------------- | --------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------- |
| `createWorker`      | 필수                                                | 필수              | 마운트 때만 읽음(`reset()`·재시작이 만드는 worker도 마운트 때 함수를 부른다)                  |
| `indexURL`          | 선택, `pyodide.indexURL`로 전달                     | 같음              | 마운트 때만                                                                                   |
| `filename`          | 선택                                                | 없음              | 마운트 때만                                                                                   |
| `topLevelAwait`     | 선택                                                | 선택              | 마운트 때만(REPL은 세션 도중 `reset({ topLevelAwait })`로만 바꾼다, `02-console-core.md` 5.4) |
| `clearOnRun`        | 선택                                                | 없음              | 마운트 때만                                                                                   |
| `copyOnSelect`      | 선택, 기본 `true`(`=== false`만 끔)                 | 같음              | **반응형**: 바뀌면 `setCopyOnSelect` 호출, 재마운트 없음                                      |
| `onCopy`            | 선택                                                | 선택              | latest-ref                                                                                    |
| `inputProvider`     | 선택(15.4)                                          | 없음              | 함수 값은 latest-ref, "있음/없음"은 마운트 때                                                 |
| `onStatus`          | `RunnerStatus`(9종, `14-runner.md` 14.3.1)          | `ReplStatus`(7종) | latest-ref(두 유니온을 섞지 않는다, 타입 시험)                                                |
| `onOutput`          | 선택                                                | 없음              | latest-ref                                                                                    |
| `onCrash`           | 선택                                                | 선택              | latest-ref                                                                                    |
| `terminalOptions`   | xterm `ITerminalOptions & ITerminalInitOnlyOptions` | 같음              | 마운트 때만, 병합 없음(15.9)                                                                  |
| `fit`               | 선택, 기본 `true`                                   | 같음              | 마운트 때만(15.5)                                                                             |
| `completionPopover` | 없음                                                | 선택, 기본 꺼짐   | 마운트 때만(`docs/design/07-tab-completion.md` 7.6)                                           |

handle은 `ref`로 얻는다.

| handle               | 멤버                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------ |
| `PythonRunnerHandle` | `run(code)`·`stop()`·`reset()`·`clear()`·`setCopyOnSelect(on)`·`focus()`, 읽기 전용 `status`(`RunnerStatus`) |
| `PythonReplHandle`   | `runSource(code)`·`reset(options?)`·`setCopyOnSelect(on)`·`focus()`, 읽기 전용 `busy`·`crossOriginIsolated`  |

- 의미는 하위 핸들과 같다(`run`·`stop`·`reset`·`clear`는 14.3·14.5, `runSource`·`busy`는 `02-console-core.md` 5.6). `focus()`만 이 패키지의 것이고 살아 있는 `Terminal.focus()`를 부른다.
- `PythonRunnerHandle`에는 `interrupt`·`busy`가 없다. terminal `TerminalRunnerHandle`에 없기 때문이다(`interrupt()`는 Ctrl+C가 부른다, 14.5). `busy`가 필요하면 terminal 핸들에 게터를 더하는 별도 항목이다. `PythonReplHandle`에는 `status`(`ReplHandle`에 게터가 없어 상태는 `onStatus`로만 받는다)·`dispose`·`terminal`이 없다.
- `Terminal` 객체는 노출하지 않는다. `terminalOptions`로 생성 옵션만 넘긴다.

## 15.3 수명과 핸들 위임 규칙

- 마운트 effect 순서: `Terminal` 생성 → `terminal.open(container)` → (`fit`이면 `FitAddon`) → 하위 핸들(`createTerminalRunner`·`createRepl`) 생성.
- cleanup 순서: **하위 핸들 `dispose()` → fit 정리(observer disconnect·대기 중 rAF 취소·addon dispose) → `Terminal.dispose()`**. 열린 읽기의 `signal` abort가 `cancelRead()`를 돌린 뒤에 화면을 뗀다(14.5.5).
- 하위 핸들 생성이 던지면(옵션 검증 오류 등) 만든 `Terminal`을 dispose한 뒤 다시 던진다. React effect 오류로 처리된다.

handle 객체는 컴포넌트 수명 내내 같은 참조다(`useImperativeHandle`, 의존 `[]`에 해당하는 안정 객체). StrictMode의 mount → cleanup → mount에서도 `ref.current`가 바뀌지 않는다. 내부의 "살아 있는 하위 핸들"만 교체된다. 살아 있는 핸들이 없는 구간(마운트 전, cleanup과 재마운트 사이, 언마운트 뒤)의 규칙:

| 멤버                                                         | 핸들 없음                                                                                                                     |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `run(code)`·`runSource(code)`                                | `RunRejectedError("disposed")`로 reject                                                                                       |
| `stop()`                                                     | `"idle"`로 resolve                                                                                                            |
| `busy`                                                       | `false`                                                                                                                       |
| `status`(`PythonRunner`)                                     | 마지막으로 통지된 값(통지 전에는 `detectRuntimeSupport()`가 `"supported"`면 `"loading"`, 아니면 그 값, `14-runner.md` 14.3.1) |
| `crossOriginIsolated`(`PythonRepl`)                          | `globalThis.crossOriginIsolated === true`(살아 있는 REPL이 있으면 그것이 만들 때 정한 값)                                     |
| 그 밖(`reset`·`clear`·`setCopyOnSelect`·`focus`·`interrupt`) | no-op                                                                                                                         |

- 첫 상태 통지(`loading`·`not-isolated`·`unsupported`)는 하위 `create*`가 반환하기 전에 동기로 온다. 그때는 아직 핸들이 없다. `onStatus`의 **첫 통지 안에서** handle을 부르면 위 "핸들 없음" 규칙이 적용된다(예: 그 안의 `run()`은 core에서는 슬롯을 차지하지만 여기서는 `disposed` 거부). 두 번째 이후 통지는 비동기라 core 규칙 그대로다.
- `busy`는 게터다. `const { busy } = usePythonRunner(...)`처럼 구조 분해하면 그 렌더 시점 값으로 굳는다. 이벤트 핸들러 안에서 `api.busy`로 읽는다. 화면 표시는 `status`(`running`·`waiting-input`)를 쓴다.
- 콜백 래퍼는 동기 재진입을 그대로 통과시킨다. 래퍼는 상태를 가두지 않고 호출만 전달한다. `onStatus` 콜백 안의 `reset()`·`dispose()`는 하위 핸들과 같은 규칙이다(`docs/traps/TRP-051`).
- 하위 핸들이 이미 dispose됐으면 위임 결과가 위 표와 같다(dispose된 core 핸들은 inert, 14.3.4). 그래서 cleanup에서 참조를 비우는 것과 결과는 같지만 GC 시점만 다르다.

## 15.4 props 변경 규칙

- **콜백**(`onStatus`·`onOutput`·`onCrash`·`onCopy`·`inputProvider`)은 latest-ref다. 하위 옵션에는 마운트 때 만든 래퍼를 한 번만 넘긴다. 래퍼가 호출 때 최신 렌더의 함수를 부른다. 그래서 인라인 람다여도 worker·`Terminal`이 재생성되지 않는다. 최신 값은 레이아웃 효과에서 갱신된다. 같은 컴포넌트의 마운트 effect는 이미 최신 값을 본다.
- **생성 옵션**(`createWorker`·`indexURL`·`filename`·`topLevelAwait`·`clearOnRun`·`terminalOptions`·`fit`)은 마운트 때만 읽는다. 바꾸려면 소비자가 `key`를 바꿔 재마운트한다. 개발 중 경고는 없다. 재렌더로 `createWorker`를 바꿔도 이후 `reset()`이 만드는 worker는 마운트 때 함수로 만들어진다(오류로 보이지 않고 무시된다).
- **`copyOnSelect`**만 반응형이다. 마운트 effect 뒤에 도는 별도 effect가 값이 바뀔 때 `setCopyOnSelect(copyOnSelect !== false)`를 부른다(생성 직후 같은 값을 한 번 더 설정하지만 무해하다).
- **`inputProvider`(`PythonRunner`)**: terminal은 생성 때 `inputProvider ?? xterm 한 줄 읽기`로 정한다.
  - 마운트 때 공급자가 없었으면 컴포넌트는 `undefined`를 넘겨 기본 읽기를 쓴다. 그 뒤 재렌더로 공급자를 넣어도 기본 읽기가 계속 쓰인다(조용함).
  - 마운트 때 있었으면 항상 최신 공급자를 부르는 래퍼를 넘긴다. 그 뒤 값이 `undefined`가 되면 읽기 취소(`null`, `input()`은 `KeyboardInterrupt`, `docs/traps/TRP-044`)다.
  - 공급자를 쓸 화면은 처음부터 함수를 주거나(`() => null`도 가능) `key`로 재마운트한다.
  - `usePythonRunner`는 기본 읽기가 없어 항상 래핑한다. 공급자가 없으면 읽기 취소다.
- `createWorker`는 latest-ref로 감싸지 않는다(위 생성 옵션 규칙).

## 15.5 fit

`fit`(기본 `true`)이면 `@xterm/addon-fit`의 `FitAddon`을 `terminal.loadAddon`하고 컨테이너에 `ResizeObserver`를 건다. `false`이면 addon도 observer도 만들지 않고 xterm 기본 80×24(또는 `terminalOptions`의 `cols`·`rows`)다.

- 컨테이너 `clientWidth` 또는 `clientHeight`가 0이면 `fit()`을 건너뛴다(숨김·레이아웃 전 상태에서 0 크기로 맞추면 xterm이 열·행을 최소로 줄인다).
- 연속 통지는 `requestAnimationFrame` 한 번으로 합친다. rAF 콜백이 실행 시점의 크기를 다시 확인한다. 마운트 직후에는 동기로 1회 맞춘다.
- `ResizeObserver`가 없는 환경(jsdom·구형 WebView)은 observer 없이 마운트 때 1회만 맞추고 던지지 않는다.
- `@xterm/addon-fit` 0.11.0은 비공개 API `terminal._core._renderService.dimensions.css.cell`·`.clear()`를 쓴다(`docs/traps/TRP-062`). 이 경로가 사라지면 `fit()`은 `TypeError`를 던진다. 컴포넌트는 삼키지 않는다: 마운트 때는 마운트 effect가 실패하고, `ResizeObserver`·rAF 경로에서는 uncaught 예외가 된다(코드 읽기로 유도, 경로를 지운 xterm으로 재현하지 않음). 렌더러가 DOM이 아니면(addon-webgl·canvas) `react-fit-check`의 `cols` 측정 셀렉터가 바뀐다.
- 실측(2026-09-25, Chromium headless, DOM 렌더러, `?fit=1`, 창 1280 → 640 → 1000 → 500px): REPL·실행창 모두 `cols` 138 → 67 → 107, 입력 대기 중 107 → 52. 스크롤바 폭 18px이 `.xterm-screen`에서 빠진다. `rows`는 데모 컨테이너 높이가 auto라 리사이즈 대상이 아니어서 확인하지 않았다(높이가 정해진 컨테이너에서의 `rows` 변화는 미확인).
- `fit`은 고정 높이(또는 명시된 높이) 컨테이너를 전제한다. 높이가 auto인 컨테이너에 `terminalOptions.rows`를 24가 아닌 값으로 주면 addon-fit의 부동소수 행 계산으로 행이 줄 수 있다는 관찰이 있다. 브라우저에서는 실측하지 않았다(코드 읽기·수치 실험 추정. 추적하는 이슈는 없다).
- 벤더 `Readline`은 재그리기 대기 중 리사이즈에서 입력줄을 그리지 않는다(`onResize`가 그때는 `refresh()`를 생략하고 콜백이 새 크기로 그린다, `06-editing.md` 6.1; jsdom 판정, 브라우저 재현은 못 했다). `react-fit-check`의 입력 대기 중 리사이즈는 프롬프트가 짧고 배경 출력이 없어 이 경로를 지나지 않는다(재현 시도가 아니다).

## 15.6 StrictMode

개발 모드 StrictMode는 mount → cleanup → mount를 돌려 하위 핸들이 2번 만들어진다. 결과: worker 2개 생성, 첫 번째는 `terminate()`, 살아 있는 것은 1개, `.xterm` 요소 1개, 정리된 `Terminal`의 콘솔 경고 0(`docs/traps/TRP-004`). `08-session.md` 8.2와 같은 판단으로 **첫 worker의 pyodide 로드 낭비는 수용한다**: 생성을 지연하는 대안은 기각했다(그릴링 확정). 프로덕션 번들은 이중 마운트를 하지 않는다.

- L0: 실제 core `createRunner`·terminal·repl과 가짜 `Worker`(생성·terminate 수를 센다)를 쓰는 jsdom + React 시험이 위 결과를 확인한다 — `PythonRunner`·`PythonRepl` 공통 계약은 `terminal-component.contract.test.tsx`(`describe.each`, RD-038), `usePythonRunner`는 `use-python-runner.test.tsx`. 실제 `@xterm/xterm`을 쓰고 `Terminal.prototype.dispose`를 `vi.spyOn`으로 센다(jsdom에는 `window.matchMedia`가 없어 vitest `setupFiles`에 스텁 1개를 둔다).
- L1: `e2e:react-strictmode`가 REPL·`?view=runner` 화면에서 `new Worker` 2회 이상·live 1개를 확인한다(15.10). Playwright `page.on('worker')`만으로는 첫 worker가 보이지 않는다(`docs/traps/TRP-061`). 셀 S04(콘솔 warning `DisposableStore` 0)는 경고 0 확인이며 정리 순서 회귀를 검출하지 못한다. 순서 방어는 L0(`Terminal.dispose` 시점의 live worker 수 시험, `docs/traps/TRP-064`)가 맡는다.
- 부모의 마운트 effect에서 `ref.current?.focus()`를 부르면 StrictMode 재마운트 뒤에도 살아 있는 `Terminal`에 닿는다. React가 자식 effect(하위 핸들·`Terminal` 생성)를 부모 effect보다 먼저 다시 돌리기 때문이다. 첫 `Terminal`에 준 포커스는 dispose와 함께 사라진다. 두 번째 effect 호출이 다시 준다(시험: "부모의 마운트 effect에서 부른 focus()는 StrictMode에서도 살아 있는 Terminal에 닿는다(autoFocus prop 불필요)"). 그래서 `autoFocus` prop은 없다.

## 15.7 `usePythonRunner`

xterm 없이 core `createRunner`를 React 수명에 붙인다. 반환은 6개로 고정이다(타입 시험).

```ts
const { status, run, stop, reset, interrupt, busy } = usePythonRunner({
  createWorker, // 필수, 마운트 때만
  onOutput, // 필수, latest-ref. stdout·stderr 원문 조각
  pyodide,
  filename,
  topLevelAwait, // 마운트 때만
  inputProvider, // latest-ref. 없으면 input()은 읽기 취소
  onStatus,
  onCrash,
  onLoadFailed, // latest-ref
});
```

- React 상태는 `status`뿐이다. `run`·`stop`·`reset`·`interrupt`는 컴포넌트 수명 내내 같은 참조다. 살아 있는 `createRunner` 핸들로 위임한다(15.3의 핸들 없음 규칙: `interrupt`는 핸들이 없으면 `"ignored"`를 돌려준다). `interrupt(): InterruptResult`(core `interrupt()`의 반환값을 그대로 돌려준다, 규칙: `14-runner.md` 14.3.3). `busy`는 게터다.
- `onOutput`·`inputProvider`는 호출자가 채운다(xterm이 없다). `<PythonRunner>`는 이 hook을 쓰지 않고 terminal 실행창을 쓴다. 수명·latest-ref 로직은 내부 공용 hook(`use-lifecycle.ts`) 하나를 둘이 공유한다.
- 초기 `status`는 일반 렌더에서 `detectRuntimeSupport()`가 `"supported"`면 `"loading"`, 아니면 그 값(첫 렌더 값, 판정 규칙
  `14-runner.md` 14.3.1)이다. 이후 `onStatus` 통지마다 갱신한다.
- 서버 렌더와 하이드레이션 첫 렌더는 `"loading"`이다
  (`useSyncExternalStore`의 서버 스냅샷, `use-lifecycle.ts` `useInitialRunnerStatus`). 서버에는 `crossOriginIsolated`가
  없다. 지원 클라이언트의 첫 렌더와 달라지는 하이드레이션 불일치를 막는다.
- 비격리·미지원 클라이언트는 하이드레이션 뒤
  마운트 effect의 첫 통지로 `not-isolated`·`unsupported`가 된다.

## 15.8 사용과 소비자 요구

```tsx
// runner.worker.ts / repl.worker.ts — 앱이 worker 파일을 조립한다(ADR-0006)
import { runDriver, runWorker } from "@cp949/runo-pyodide-core/worker";
runWorker({ driver: runDriver });
// REPL은: import { runReplWorker } from "@cp949/runo-pyodide-repl/worker"; runReplWorker();

// App.tsx
import {
  PythonRunner,
  type PythonRunnerHandle,
} from "@cp949/runo-pyodide-repl-react";
import "@xterm/xterm/css/xterm.css";

const createWorker = () =>
  new Worker(new URL("./runner.worker.ts", import.meta.url), {
    type: "module",
  });

function App() {
  const ref = useRef<PythonRunnerHandle>(null);
  return (
    <>
      <button onClick={() => ref.current?.run('print("hi")')}>run</button>
      <PythonRunner
        ref={ref}
        createWorker={createWorker}
        onStatus={(s) => {}}
        style={{ height: 360 }}
      />
    </>
  );
}
```

- 페이지가 cross-origin isolated여야 한다(COOP/COEP, dev·preview·배포 모두, ADR-0004). 아니면 worker를 만들지 않는다. 상태는
  `not-isolated`다. 브라우저가 pyodide 런타임 wasm 기능을 지원하지 않으면(빌드 floor 이상이어도 런타임 floor 미만일 수
  있다) worker를 만들지 않고 `unsupported`다(상태 규칙: `14-runner.md` 14.3.1).
- worker 파일은 앱이 만든다(`createWorker`가 마운트 때 함수를 그대로 쓴다). Vite `worker.format`은 `'es'`로 둔다(module worker와 맞춘다, `00-architecture.md` 4.1).
- `@xterm/xterm`(`^6.0.0`)·`react`·`react-dom`(`^19.0.0`)은 소비자가 설치한다(peer). `xterm.css`는 소비자가 import한다. worker 파일이 `@cp949/runo-pyodide-core/worker`를 import하면 그 타입 때문에 소비자가 `pyodide` 타입(+`@types/node`·`@types/emscripten`)을 설치해야 한다(`packages/pyodide-core/README.md`). react·core·terminal·repl의 `.` 진입점 `.d.mts`에는 `pyodide` import가 없다(`grep`으로 확인. `pyodide`를 뺀 소비자의 `tsc`는 실행하지 않았다: `pnpm smoke:pack` 소비자는 `pyodide`를 설치한다).
- `fit`이 켜졌으면 컨테이너에 크기를 준다(위 예의 `style`). 높이가 0이거나 `display: none`이면 `fit()`을 건너뛴다.
- `@xterm/xterm` 6.0.0은 `main`이 CommonJS다. 번들 없는 Node ESM(SSR 서버가 패키지를 외부 모듈로 평가)에서 `import { Terminal }`이 던진다. 패키지는 네임스페이스로 받고 마운트 때 `Terminal`을 고른다(`terminal-view.ts` `resolveTerminal`, `docs/traps/TRP-063`).

## 15.9 비지원과 판단 기록

비지원:

- **iframecall 어댑터**: 앱 계층이다. 이 패키지는 브라우저 안 컴포넌트·hook만 낸다.
- **`Terminal` 객체 노출**: handle에 `terminal`이 없다. 생성 옵션은 `terminalOptions`로만 준다.
- **생성 옵션 변경**: 마운트 때만 읽는다(15.4). 바꾸려면 `key`로 재마운트한다.
- **`autoFocus` prop**: 없다(15.6, `ref.current?.focus()`를 부모의 마운트 effect에서 부른다).
- **`PythonRunner`의 `interrupt`·`busy`**: terminal 핸들에 없어 노출하지 않는다(15.2).
- REPL + dom-bridge 조합은 지원하지 않는다(ADR-0006). `<PythonRunner createWorker={…}>`에 dom-bridge worker를 주입하는 조합은 react 패키지 변경 없이 동작하고 demo `?view=dom-bridge`가 시험한다(`16-dom-bridge.md` 16.13).
- SSR 렌더링은 `usePythonRunner`의 `status`만 시험한다(`renderToString` → `hydrateRoot`, 격리·비격리 클라이언트에서 `onRecoverableError` 0). 컴포넌트의 SSR은 시험하지 않았다. `Terminal`·worker는 마운트 effect 안에서만 만든다. 번들 없는 Node ESM에서의 모듈 평가는 `pnpm smoke:pack`의 import 검사가 확인한다.

판단 기록:

- **`terminalOptions` 무병합**: `new Terminal(terminalOptions)`로 그대로 넘긴다(컴포넌트가 몰래 더한 옵션이 없다). demo의 기존 `cursorBlink: true`는 `terminalOptions={{ cursorBlink: true }}`로 넘긴다. 타입은 `cols`·`rows`가 init 전용이라 `ITerminalOptions & ITerminalInitOnlyOptions`다.
- **`inputProvider` 마운트 때 결정**: 15.4.
- **`reset()`의 `createWorker`**: 마운트 때 함수. 15.4.
- **`@xterm/xterm` 네임스페이스 import**: 15.8.
- **`cols` 측정법(`react-fit-check`)**: 데모가 `Terminal`을 노출하지 않으므로 DOM 기하(`.xterm-screen` 너비 ÷ 셀 너비)로 폴링 판정한다. `x` 400자 출력의 줄바꿈 폭을 교차 확인한다(실측 107 = 107). 폰트에 따라 절대 값이 달라진다. 방향(감소·증가)과 "≠ 80"만 판정한다. 판정 함수는 `apps/demo/e2e/react-judge.mjs`(순수 함수)와 `react-judge.test.mjs`(28개)다.
- **시험 파일**: 확장자 `.test.tsx`, `react-dom/client` + `act`를 쓰고 `@testing-library/react`는 추가하지 않았다.
- **`data-testid`**: 컴포넌트가 div 속성을 통과시키므로 demo의 `data-testid="terminal"`이 컨테이너 div에 붙어 e2e 셀렉터(`.xterm-rows > div`·`[data-testid="terminal"]`)가 그대로 통한다.

## 15.10 검증

- L0(`pnpm --filter @cp949/runo-pyodide-repl-react test`, jsdom): 120개. 구성:
  - 경계 2(`package-boundary.test.ts`)
  - `use-lifecycle-unsupported.test.ts` 1(wasm 미지원 시 `initialRunnerStatus()`, node 환경)
  - `use-python-runner.test.tsx` 29
  - `terminal-component.contract.test.tsx` 38(`describe.each`, `PythonRunner`·`PythonRepl` 공통 계약 고유 19제목 × adapter 2)
  - `python-runner.test.tsx` 19(고유)
  - `python-repl.test.tsx` 23(고유)
  - `terminal-view.test.ts` 8(fit 세부, React 없이 `mountTerminalView` 직접 시험)
- L0 개수 이력:
  - RD-024 병합 때 107개.
  - 사후 리뷰에서 4개 추가: hook 생성 옵션 전달, `PythonRunner` 생성 실패 시 `Terminal` 정리, rAF 콜백의 실행 시점 크기 재확인, `ResizeObserver` 없을 때 마운트 1회 fit.
  - `usePythonRunner` SSR 하이드레이션 3건으로 114.
  - RD-038이 계약 suite 추출·fit 시험 이동으로 114 → 116. runner 전용이던 StrictMode observer 시험이 repl에도 돈다(+1). observer 끊기·rAF 취소 시험이 계약 suite의 "언마운트하면 observer를 끊는다"와 `terminal-view.test.ts`로 나뉜다(+1).
  - 이동·중복 커버리지만이고 삭제 0.
  - RD-038 이후 `use-lifecycle-unsupported.test.ts` 1개(`unsupported` 도입), `python-runner.test.tsx` 1개, `python-repl.test.tsx` 2개가 늘어 120이다(2026-09-29 실측, 개수만 확인했고 추가 시점은 확인하지 않았다).
- L0 도구: 공용 가짜 `Worker`(`@cp949/runo-pyodide-core/test-utils`의 `createFakeWorkerFactory`)와 실제 `createRunner`·`createTerminalRunner`·`createRepl`·`@xterm/xterm`을 쓴다.
- L0 확인 항목: StrictMode worker·`.xterm` 수, 언마운트 뒤 worker 0·`Terminal.dispose` 호출, 인라인 콜백 재렌더에서 worker·`Terminal` 수 불변, 핸들 위임 규칙(15.3), `copyOnSelect` 토글, fit(가짜 `ResizeObserver`·rAF로 크기 0 가드·통지 합침·`fit={false}`), 정리 순서(`Terminal.prototype.dispose` 시점의 live worker 수 `[0, 0]`), 타입 유도(`expectTypeOf`).
- 변이 검사: `usePythonRunner` 20개 중 19 killed·1 동등, `PythonRunner` 40개 중 38 killed·2 동등, `PythonRepl` 31개 중 30 killed·1 동등.
  - 살아남은 4건은 다른 경로가 같은 결과를 만들어 관찰할 수 없는 변이다:
    - cleanup에서 핸들 참조를 비우지 않기(dispose된 핸들이 inert)
    - 생성 때 `copyOnSelect` 옵션 전달 제거(마운트 직후 effect가 같은 값을 다시 설정, 두 컴포넌트)
    - `status`가 항상 마지막 통지 값을 돌려주기(core `status`와 마지막 통지가 항상 같음)
  - 정리 순서를 뒤집는 변이는 콘솔 경고 단언으로는 잡히지 않는다. `dispose` 시점의 live worker 수 단언으로 잡는다(`docs/traps/TRP-064`).
  - 사후 리뷰(2026-09-25)에서 위 목록에 없던 변이 4개가 살아남는 것을 찾아 시험 4개를 더했다. 각 변이가 새 시험 하나만으로 실패함을 확인했다.
    - hook의 `filename` 전달 제거
    - `PythonRunner` 생성 실패 `catch`의 `view.dispose()` 제거
    - 크기 0 가드를 rAF 콜백에서 통지 시점으로 옮김
    - 마운트 1회 fit을 `ResizeObserver`가 있을 때만
  - 정리 순서 중 fit 정리의 위치(`Terminal.dispose` 앞)는 시험하지 않는다(xterm이 dispose 때 addon도 정리한다).
  - 경고 0 단언(`warnSpy`)은 대기 중인 write 콜백을 만들지 않아 TRP-004 회귀를 검출하지 못한다(브라우저 S04 몫).
- L1(dev 서버, 각 1회): `e2e:react-strictmode` 10/10(REPL·실행창 각 5)·`e2e:react-fit` 12/12(각 6). 기존 스크립트 10종(`runner-check` normal·not-isolated, `repl-check`·`ctrl-c`·`stdin-input`·`prompt-cancel`·`run-source`·`session-reset`·`selection-copy`·`tla`)은 demo를 컴포넌트로 옮긴 뒤 기준선과 같은 개수·`pageErrors`였다. 개수·판정은 `apps/demo/e2e/BASELINE.md`.
- 패키지 경계: `test/package-boundary.test.ts`(의존 트리에 coincident·reflected-ffi 없음), `pnpm check-dist`, `pnpm smoke:pack`(react tarball 포함, tarball의 `react`·`react-dom`·`@xterm/xterm` peer 선언과 `@xterm/addon-fit` 정확 버전, 공개 진입점 import·소비자 `tsc --noEmit`·설치 트리 검사, `09-testing.md` 9.8). import는 모듈 평가만 하므로 `resolveTerminal()`의 `default` 폴백(TRP-063)은 어느 시험도 실행하지 않는다.
- 한계: (1) fit 판정은 헤드리스 Chromium·DOM 렌더러 기준이다. (2) 언마운트 정리는 브라우저로 보지 않고 L0가 맡는다(demo에 뷰 교체가 없다). (3) preview(빌드 산출물)·L2 전체 기준선은 실행하지 않았다. (4) 시험은 가짜 worker라 실제 pyodide 로드·실제 `fit()` 셀 크기는 L1이 본다.
