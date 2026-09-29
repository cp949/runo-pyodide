import { lazy, Suspense } from "react";
import { ReplView } from "./ReplView";
import { RunnerView } from "./RunnerView";

/**
 * dom-bridge 실행창(`?view=dom-bridge`, RD-023). 지연 import한다.
 * - 이 화면만 coincident를 가져온다.
 * - coincident는 평가될 때 전역 `EventTarget.prototype.addEventListener`를 패치한다(docs/design/16-dom-bridge.md).
 * - REPL·실행창 화면은 이 모듈을 평가하지 않는다.
 */
const DomBridgeView = lazy(() =>
  import("./DomBridgeView").then((m) => ({ default: m.DomBridgeView })),
);

const params = new URLSearchParams(globalThis.location.search);

/**
 * 쿼리 `?view=`가 고르는 화면.
 * - `runner`: 실행창.
 * - `dom-bridge`: dom-bridge 실행창.
 * - 그 밖: REPL.
 *
 * 페이지당 xterm은 하나만 둔다(e2e 셀렉터 유지).
 */
const view = params.get("view");

/** 쿼리 `?fit=1`일 때만 xterm이 컨테이너 크기를 따른다(RD-024). 기본은 xterm 기본 80×24로, e2e 기준선을 유지한다. */
const fit = params.get("fit") === "1";

/** 쿼리 `?completionPopover=1`이면 REPL 화면에 completion popover(RD-049)를 켠다. 기본은 꺼짐(텍스트 목록). */
const completionPopover = params.get("completionPopover") === "1";

/**
 * 예제 사이 네비게이션(RD-023).
 * 실제 페이지 이동(`<a>`)을 쓴다.
 * dom-bridge는 coincident 전역 패치 순서 제약이 있어, 같은 페이지에서 다른 예제로 전환하면 안전하지 않다.
 */
function Nav() {
  const examples: { view: string | null; testid: string; label: string }[] = [
    { view: null, testid: "nav-repl", label: "REPL" },
    { view: "runner", testid: "nav-runner", label: "Runner" },
    { view: "dom-bridge", testid: "nav-dom-bridge", label: "Dom Bridge" },
  ];
  return (
    <nav>
      {examples.map((e) => (
        <a
          key={e.testid}
          data-testid={e.testid}
          href={e.view === null ? "/" : `/?view=${e.view}`}
          aria-current={view === e.view ? "page" : undefined}
        >
          {e.label}
        </a>
      ))}
    </nav>
  );
}

/** 데모 루트. 쿼리 `?view=`에 따라 REPL·실행창·dom-bridge 실행창 중 하나를 렌더링한다. */
export function App() {
  return (
    <main>
      <h1>runo-pyodide-repl</h1>
      <Nav />
      <p>
        crossOriginIsolated:{" "}
        <output data-testid="cross-origin-isolated">
          {String(globalThis.crossOriginIsolated === true)}
        </output>
      </p>
      {view === "runner" ? (
        <RunnerView fit={fit} />
      ) : view === "dom-bridge" ? (
        <Suspense fallback={null}>
          <DomBridgeView fit={fit} />
        </Suspense>
      ) : (
        <ReplView fit={fit} completionPopover={completionPopover} />
      )}
    </main>
  );
}
