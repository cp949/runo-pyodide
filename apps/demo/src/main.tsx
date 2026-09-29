import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./App.css";

// Chrome 84(빌드 floor)는 `Element.prototype.replaceChildren`이 없다(Chrome 86+). xterm 6이 행 렌더마다
// 이 메서드를 부르므로(`@xterm/xterm/lib/xterm.js`, `TerminalRenderer.clear()`·`renderRows()`) 없으면 매
// 렌더 pageerror가 난다(실측). ECMAScript 문법·API가 아니라 DOM API라 `core-js`로는 못 고친다
// (checklist가 가정한 "H3 실패 시 core-js/stable" 대응이 이 경우엔 안 맞는다).
// 데모 전용 폴리필(라이브러리에는 넣지 않는다, geul ADR-0009와 같은 원칙).
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
