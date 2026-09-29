import { detectRuntimeSupport } from "@cp949/runo-pyodide-core";
import { PythonRepl, RunRejectedError } from "@cp949/runo-pyodide-repl-react";
import type {
  CopyResult,
  PythonReplHandle,
  ReplStatus,
} from "@cp949/runo-pyodide-repl-react";
import "@xterm/xterm/css/xterm.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { createWorker } from "./create-worker";

/**
 * 이 브라우저가 pyodide 세션을 만들 수 있는가.
 * 세션이 없으면(비격리·런타임 미지원) 리셋 버튼과 top-level await 체크박스도 못 쓴다.
 * 규칙은 RD-010 확정 8, docs/adr/0008-chrome84-build-floor-and-pyodide-runtime-floor.md.
 */
const supported = detectRuntimeSupport() === "supported";

/** 드래그 자동 복사 on/off를 저장하는 localStorage 키(RD-017 확정 6). */
const COPY_ON_SELECT_KEY = "runo-repl.copyOnSelect";

/** 저장된 자동 복사 설정을 읽는다. `"0"`이면 꺼짐. 그 외·없음·읽기 에러면 켜짐(기본값). */
function readCopyOnSelect(): boolean {
  try {
    return localStorage.getItem(COPY_ON_SELECT_KEY) !== "0";
  } catch {
    return true;
  }
}

/**
 * completion popover를 켜거나 끄고 페이지를 다시 불러온다(RD-049).
 * 옵션은 마운트 때만 읽히고 세터가 없다. 바꾸려면 다시 마운트해야 한다.
 * 쿼리 `completionPopover`가 유일한 원천이다. 다른 쿼리는 보존한다.
 */
function reloadWithCompletionPopover(on: boolean): void {
  const params = new URLSearchParams(globalThis.location.search);
  if (on) params.set("completionPopover", "1");
  else params.delete("completionPopover");
  globalThis.location.search = params.toString();
}

/** `runSource()`가 실패했을 때 결과 칸에 보여 줄 문자열. 거부는 `{"rejected":"<reason>"}`, 그 밖은 `{"error":"<message>"}`. */
function describeError(error: unknown): string {
  if (error instanceof RunRejectedError)
    return JSON.stringify({ rejected: error.reason });
  return JSON.stringify({ error: String(error) });
}

/**
 * REPL 데모 화면. `<PythonRepl>`(`@cp949/runo-pyodide-repl-react`, RD-024)로 xterm 터미널과 REPL 세션을 마운트한다.
 * Terminal 생성·정리는 컴포넌트가 맡는다.
 *
 * 크기:
 * - 기본은 xterm 기본값(80×24)이다(`fit={false}`, e2e 기준선 유지).
 * - 쿼리 `?fit=1`이면 `fit`이 켜져 컨테이너 크기를 따른다(`App`이 prop으로 넘긴다).
 *
 * 상태와 알림:
 * - 세션 상태는 `onStatus` 값을 그대로 보여 준다.
 * - `exit()`로 세션이 끝나면(`terminated`) 종료 Alert가 뜬다.
 * - worker가 죽으면(`crashed`) 크래시 Alert와 재시작 버튼이 뜬다.
 * - 터미널은 크래시 중에도 렌더한다. 화면의 출력이 단서다.
 *
 * 세션 리셋:
 * - 리셋 버튼은 상시 있고 `reset()`을 부른다(RD-010).
 * - top-level await 체크박스는 바뀔 때마다 `reset({ topLevelAwait })`를 부른다(RD-012).
 * - 이 값은 저장하지 않는다. 새로고침하면 항상 꺼짐이다.
 * - 리셋 버튼·크래시 재시작은 무인자라 마지막 값을 유지한다(sticky, 코어가 보관).
 *
 * 복사(RD-017):
 * - "선택 시 자동 복사" 체크박스는 localStorage에 저장한다(`COPY_ON_SELECT_KEY`).
 * - Ctrl+C 복사는 이 값과 무관하게 항상 동작한다.
 * - 복사 결과는 우측 하단 토스트로 1초간 보여 준다.
 *
 * `runSource(code)` 시험용 plain 요소:
 * - `textarea`(`source`), 버튼(`run-source`), 결과(`source-result`).
 * - 결과는 JSON 텍스트다. 거부는 `{"rejected":"<reason>"}`.
 * - 새 호출을 시작하면 이전 결과를 지운다.
 * - 늦게 끝난 이전 호출은 결과 칸을 쓰지 않는다(RD-022a).
 * - 결과 칸은 xterm DOM보다 먼저 바뀔 수 있다.
 *
 * completion popover(RD-049):
 * - `completionPopover`는 `?completionPopover=1`일 때만 참이다.
 * - 마운트 때만 `<PythonRepl>`에 배선한다.
 * - "completion popover" 체크박스는 쿼리를 바꿔 페이지를 다시 불러온다(`reloadWithCompletionPopover`).
 */
export function ReplView({
  fit,
  completionPopover,
}: {
  fit: boolean;
  completionPopover: boolean;
}) {
  const replRef = useRef<PythonReplHandle>(null);
  const [status, setStatus] = useState<ReplStatus>("loading");
  const [crashMessage, setCrashMessage] = useState<string | null>(null);
  const [topLevelAwait, setTopLevelAwait] = useState(false);
  const [copyOnSelect, setCopyOnSelect] = useState(readCopyOnSelect);
  const [toast, setToast] = useState<string | null>(null);
  const [source, setSource] = useState("");
  const [sourceResult, setSourceResult] = useState("");
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // `runSource` 호출 번호.
  // 늦게 끝난 이전 호출이 새 결과를 덮어쓰지 않게 한다. 예: 실행 중 다시 눌러 `busy`를 받은 뒤 끝난 첫 호출.
  const sourceCallRef = useRef(0);

  // 복사 결과를 토스트로 보여 주고 1초 뒤 지운다. 연속 복사는 타이머를 새로 건다.
  // `PythonRepl`의 `onCopy`는 latest-ref라 콜백 식별자가 바뀌어도 재마운트하지 않는다. `useCallback`은 필수가 아니다.
  const showToast = useCallback((result: CopyResult) => {
    setToast(
      result.ok ? `copied ${result.chars} chars to clipboard` : "copy failed",
    );
    if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => {
      toastTimerRef.current = null;
      setToast(null);
    }, 1000);
  }, []);

  // 마운트 때 터미널에 포커스를 준다.
  // 자식(`PythonRepl`)의 마운트 effect가 부모보다 먼저 돌아, StrictMode 재마운트 뒤에도 살아 있는 Terminal에 닿는다.
  // `PythonRepl`에는 `autoFocus` prop이 없다.
  useEffect(() => {
    replRef.current?.focus();
  }, []);

  // 언마운트하면 토스트 타이머를 정리한다. 위 포커스 effect와 별도 effect다.
  useEffect(() => {
    return () => {
      if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current);
    };
  }, []);

  // `source`를 `runSource`로 실행하고 결과를 `sourceResult`에 반영한다.
  // 터미널에 포커스를 주지 않는다. 치던 줄·`input()` 입력은 호출자가 정한다.
  const runSource = () => {
    const repl = replRef.current;
    if (repl === null) return;
    setSourceResult("");
    const call = ++sourceCallRef.current;
    // 이 호출이 가장 최근 호출일 때만 결과 칸을 쓴다.
    const show = (text: string) => {
      if (call === sourceCallRef.current) setSourceResult(text);
    };
    repl.runSource(source).then(
      (result) => show(JSON.stringify(result)),
      (error: unknown) => show(describeError(error)),
    );
  };

  return (
    <>
      <p>
        status: <output data-testid="status">{status}</output>
      </p>
      <button
        type="button"
        data-testid="reset"
        disabled={!supported}
        onClick={() => replRef.current?.reset()}
      >
        세션 리셋
      </button>
      <label>
        <input
          type="checkbox"
          data-testid="top-level-await"
          checked={topLevelAwait}
          disabled={!supported}
          onChange={(e) => {
            const on = e.target.checked;
            setTopLevelAwait(on);
            replRef.current?.reset({ topLevelAwait: on });
          }}
        />{" "}
        top-level await
      </label>
      <label>
        <input
          type="checkbox"
          data-testid="copy-on-select"
          checked={copyOnSelect}
          onChange={(e) => {
            const on = e.target.checked;
            setCopyOnSelect(on);
            try {
              localStorage.setItem(COPY_ON_SELECT_KEY, on ? "1" : "0");
            } catch {
              // localStorage 접근 불가(사생활 보호 모드 등). state만 유지한다.
            }
            replRef.current?.setCopyOnSelect(on);
          }}
        />{" "}
        선택 시 자동 복사
      </label>
      <label>
        <input
          type="checkbox"
          data-testid="completion-popover"
          checked={completionPopover}
          onChange={(e) => reloadWithCompletionPopover(e.target.checked)}
        />{" "}
        completion popover(새로고침)
      </label>
      <div>
        <textarea
          data-testid="source"
          rows={4}
          cols={80}
          spellCheck={false}
          value={source}
          onChange={(e) => setSource(e.target.value)}
        />
      </div>
      <div>
        <button type="button" data-testid="run-source" onClick={runSource}>
          run-source
        </button>
      </div>
      <p>
        source-result:{" "}
        <output data-testid="source-result">{sourceResult}</output>
      </p>
      {status === "terminated" && (
        <div role="alert" data-testid="terminated">
          Python session terminated. "세션 리셋" 버튼으로 새 세션을 시작하세요.
        </div>
      )}
      {status === "crashed" && (
        <div role="alert" data-testid="crashed">
          worker가 예기치 않게 종료됐습니다: {crashMessage}{" "}
          <button
            type="button"
            data-testid="restart"
            onClick={() => {
              // 먼저 비운다. 재생성이 또 실패하면 `reset()` 안에서 `onCrash`가 새 메시지를 넣는다.
              setCrashMessage(null);
              replRef.current?.reset();
            }}
          >
            재시작
          </button>
        </div>
      )}
      <PythonRepl
        ref={replRef}
        data-testid="terminal"
        createWorker={createWorker}
        terminalOptions={{ cursorBlink: true }}
        fit={fit}
        completionPopover={completionPopover}
        copyOnSelect={copyOnSelect}
        onStatus={setStatus}
        onCrash={setCrashMessage}
        onCopy={showToast}
      />
      {toast !== null && (
        <div
          role="status"
          data-testid="copy-toast"
          style={{
            position: "fixed",
            right: 16,
            bottom: 16,
            fontSize: 12,
            padding: "4px 8px",
            borderRadius: 4,
            background: "#333",
            color: "#fff",
          }}
        >
          {toast}
        </div>
      )}
    </>
  );
}
