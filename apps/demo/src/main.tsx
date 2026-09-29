import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./App.css";

// `Element.prototype.replaceChildren` 데모 전용 폴리필.
// - Chrome 84(빌드 floor)에는 이 메서드가 없다. Chrome 86부터 있다.
// - xterm 6이 행 렌더마다 이 메서드를 부른다(`@xterm/xterm/lib/xterm.js`, `TerminalRenderer.clear()`·`renderRows()`).
// - 없으면 렌더마다 pageerror가 난다(실측).
// - DOM API라 `core-js`로 고칠 수 없다.
// - 라이브러리에는 넣지 않는다. 데모에만 허용한다(docs/adr/0008-chrome84-build-floor-and-pyodide-runtime-floor.md).
if (typeof Element !== "undefined" && !Element.prototype.replaceChildren) {
  Element.prototype.replaceChildren = function (...nodes: (Node | string)[]) {
    while (this.firstChild) this.removeChild(this.firstChild);
    if (nodes.length > 0) this.append(...nodes);
  };
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
