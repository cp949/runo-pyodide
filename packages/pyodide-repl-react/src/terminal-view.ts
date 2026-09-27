/**
 * 컴포넌트가 공유하는 xterm 화면 수명(RD-024). 컨테이너에 `Terminal`을 만들어 열고 필요하면 `FitAddon`을 붙인다.
 * 반환하는 `dispose()`는 fit 정리(observer·rAF·addon) → `Terminal.dispose()` 순서다. 이 뷰를 쓰는 쪽은 runner(또는 REPL)를 먼저
 * dispose한 뒤 이 `dispose()`를 불러야 한다(14.5.5: 열린 읽기의 abort가 `cancelRead()`를 돌린 뒤에 줄 편집기·터미널을 뗀다).
 */
import { FitAddon } from "@xterm/addon-fit";
import * as xterm from "@xterm/xterm";
import type {
  ITerminalInitOnlyOptions,
  ITerminalOptions,
  Terminal,
} from "@xterm/xterm";

export interface TerminalView {
  readonly terminal: Terminal;
  dispose(): void;
}

export interface TerminalViewOptions {
  terminalOptions?: ITerminalOptions & ITerminalInitOnlyOptions;
  /** `true`면 `FitAddon`을 붙이고 컨테이너 크기 변화에 맞춘다. */
  fit: boolean;
}

/**
 * `@xterm/xterm`은 CommonJS 진입(`main`)과 ESM 진입(`module`, 번들러 전용)을 함께 낸다. 번들러(Vite·webpack)는 후자라 네임스페이스에
 * `Terminal`이 있고, 번들 없이 Node ESM으로 읽으면(SSR 서버 등) 이름 내보내기를 못 보고 `default`만 있다. 최상위 이름 import
 * (`import { Terminal }`)는 후자에서 모듈 평가 때 `SyntaxError`로 던지므로 네임스페이스로 받아 마운트 때 고른다.
 */
function resolveTerminal(): typeof Terminal {
  const namespace = xterm as typeof xterm & { default?: typeof xterm };
  return (namespace.Terminal ?? namespace.default?.Terminal)!;
}

export function mountTerminalView(
  container: HTMLElement,
  options: TerminalViewOptions,
): TerminalView {
  const terminal = new (resolveTerminal())(options.terminalOptions);
  let detachFit: (() => void) | undefined;
  try {
    terminal.open(container);
    if (options.fit) detachFit = attachFit(terminal, container);
  } catch (error) {
    detachFit?.();
    terminal.dispose();
    throw error;
  }
  return {
    terminal,
    dispose() {
      detachFit?.();
      terminal.dispose();
    },
  };
}

/**
 * `FitAddon`을 붙이고 컨테이너 `ResizeObserver`로 `fit()`을 부른다. 컨테이너 크기가 0이면(숨김·레이아웃 전) 건너뛴다: 0 크기로
 * `fit()`하면 xterm이 열·행을 최소로 줄인다. 연속 통지는 `requestAnimationFrame` 한 번으로 합친다(리사이즈 드래그 중 통지
 * 폭주를 프레임당 1회로 줄이고 xterm 렌더 중 리사이즈를 피한다). 마운트 직후 1회 맞춘다. 반환 함수가 observer·대기 중 rAF·addon을 정리한다.
 */
function attachFit(terminal: Terminal, container: HTMLElement): () => void {
  const addon = new FitAddon();
  terminal.loadAddon(addon);

  const fitNow = () => {
    if (container.clientWidth === 0 || container.clientHeight === 0) return;
    addon.fit();
  };
  let frame: number | undefined;
  const schedule = () => {
    if (frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      fitNow();
    });
  };

  fitNow();
  // `ResizeObserver`가 없는 환경(구형 WebView·jsdom)은 마운트 때 1회만 맞춘다.
  const observer =
    typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(schedule);
  observer?.observe(container);

  return () => {
    observer?.disconnect();
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    addon.dispose();
  };
}
