// RD-024 DELTA-06: react-strictmode-check·react-fit-check의 판정 함수. 브라우저 없이 가짜 입력으로 시험할 수 있게 순수 함수로
// 분리했다(`react-judge.test.mjs`, 양성 대조). 시간 값은 받지 않는다: 판정은 이벤트 열·DOM 수치·화면 행만 본다(9.7).

/**
 * Playwright `page.on('worker')`(생성)·`worker.on('close')`(종료) 이벤트 열을 집계한다.
 * `events`는 `{ type: "created" | "closed", id }` 배열이다. 같은 id의 `closed`가 여러 번 와도 한 번으로 세고, 생성 이벤트가 없던
 * id의 `closed`는 무시한다. 살아 있는 수(`live`)는 생성됐지만 아직 닫히지 않은 id의 수다.
 * 옛 worker는 `terminate()` 뒤 Chromium이 최대 약 2초 늦게 닫으므로(TRP-049) 호출자는 `live`가 기대값이 될 때까지 폴링한다.
 */
export function tallyWorkers(events) {
  const created = new Set();
  const closed = new Set();
  for (const e of events) {
    if (e.type === "created") created.add(e.id);
    else if (e.type === "closed" && created.has(e.id)) closed.add(e.id);
  }
  return { created: created.size, closed: closed.size, live: created.size - closed.size };
}

/**
 * 페이지 안 `Worker` 계측(`installWorkerProbe`가 심는 init script)의 기록 `["new" | "terminate", ...]`에서 생성·종료 호출 수를 센다.
 * Playwright `page.on('worker')`는 생성 직후 `terminate()`된 worker(StrictMode 첫 마운트의 것)를 관측하지 못해(2026-09-25 실측: 생성
 * 이벤트 1개, `new Worker` 호출 2개) 이중 마운트가 실제로 일어났는지는 이 계측으로 본다.
 */
export function tallyWorkerCalls(calls) {
  const constructed = calls.filter((c) => c === "new").length;
  const terminated = calls.filter((c) => c === "terminate").length;
  return { constructed, terminated, logicalLive: constructed - terminated };
}

/**
 * StrictMode dev 화면의 worker 수 판정. 입력은 페이지 계측의 `constructed`·`terminated`(`tallyWorkerCalls`)와 Playwright 이벤트의
 * 살아 있는 수 `live`(`tallyWorkers`)다. `constructed`가 2 미만이면 이중 마운트가 관측되지 않은 것이라 "살아 있는 worker 1"이
 * 컴포넌트가 정리해서가 아니라 애초에 하나만 만들어서일 수 있다(빈 통과). 그래서 생성 2개 이상을 함께 요구한다. 살아 있는 수는 두
 * 독립 근거(Playwright 종료 이벤트, 계측의 생성 − terminate 호출)가 모두 1이어야 한다.
 * @returns {{ ok: boolean, reason: string }}
 */
export function judgeStrictModeWorkers({ constructed, terminated, live }) {
  if (constructed < 2) {
    return { ok: false, reason: `new Worker 호출 ${constructed}회: StrictMode 이중 마운트가 관측되지 않았다(기대 2회 이상)` };
  }
  if (live !== 1) return { ok: false, reason: `살아 있는 worker ${live}개(Playwright 이벤트, new ${constructed}회·terminate ${terminated}회, 기대 1개)` };
  if (constructed - terminated !== 1) {
    return { ok: false, reason: `terminate 호출 ${terminated}회(new ${constructed}회): 정리되지 않은 worker ${constructed - terminated - 1}개` };
  }
  return { ok: true, reason: `new ${constructed}회·terminate ${terminated}회, 살아 있는 worker 1개` };
}

/**
 * 콘솔 기록(`{ source, type, text }`)에서 `needle`을 포함한 warning의 수. TRP-004(`DisposableStore` 경고)는 page 콘솔에 온다.
 */
export function countWarnings(logs, needle) {
  return logs.filter((l) => l.type === "warning" && l.text.includes(needle)).length;
}

/**
 * xterm DOM 렌더러의 열 수를 화면 기하에서 구한다. `.xterm-screen` 너비는 `cols × 셀 너비`이고, 셀 너비는
 * `.xterm-char-measure-element`(글자 `measureChars`개를 담은 요소)의 너비를 글자 수로 나눈 값이다. 반올림은 `.xterm-screen`
 * 너비가 정수 px로 반올림돼 있어서다. 입력이 유효하지 않으면 `NaN`.
 */
export function colsFromGeometry({ screenWidth, measureWidth, measureChars }) {
  if (!(screenWidth > 0) || !(measureWidth > 0) || !(measureChars > 0)) return Number.NaN;
  return Math.round(screenWidth / (measureWidth / measureChars));
}

/**
 * 창 크기를 바꾼 뒤 `cols`가 기대 방향으로 바뀌었는지. `direction`은 "shrink"(줄어야 한다) 또는 "grow"(늘어야 한다).
 * 같은 값은 실패다(fit이 동작하지 않은 것). 열 수가 양의 정수가 아니면(NaN 등) 측정 실패로 실패다.
 * @returns {{ ok: boolean, reason: string }}
 */
export function judgeColsChange(before, after, direction) {
  const valid = (n) => Number.isInteger(n) && n > 0;
  if (!valid(before) || !valid(after)) return { ok: false, reason: `cols 측정 실패(전 ${before}, 후 ${after})` };
  if (direction !== "shrink" && direction !== "grow") throw new Error(`direction = ${direction}`);
  if (after === before) return { ok: false, reason: `cols가 바뀌지 않았다(${before})` };
  if (direction === "shrink" && after > before) return { ok: false, reason: `줄어야 하는데 늘었다(${before} → ${after})` };
  if (direction === "grow" && after < before) return { ok: false, reason: `늘어야 하는데 줄었다(${before} → ${after})` };
  return { ok: true, reason: `${before} → ${after}` };
}

/**
 * 화면 행에서 글자 `ch`만으로 이뤄진 행이 줄바꿈으로 이어지는 첫 구간의 첫 행 길이를 돌려준다. `ch`를 열 수보다 많이 출력하면
 * 앞 행은 꽉 차므로 그 길이가 xterm 버퍼의 실제 `cols`다(DOM 기하와 별개의 근거). 꽉 찬 행이 없으면 `null`.
 */
export function wrappedRowCols(rows, ch = "x") {
  const only = (r) => r.length > 0 && [...r].every((c) => c === ch);
  for (let i = 0; i + 1 < rows.length; i += 1) {
    if (only(rows[i]) && only(rows[i + 1])) return rows[i].length;
  }
  return null;
}

/**
 * 줄바꿈 폭(`wrappedRowCols`)과 DOM 기하 열 수가 같은지.
 * @returns {{ ok: boolean, reason: string }}
 */
export function judgeWrapMatchesGeometry(rows, geometryCols, ch = "x") {
  const wrapped = wrappedRowCols(rows, ch);
  if (wrapped === null) return { ok: false, reason: `줄바꿈으로 이어진 '${ch}' 행이 없다` };
  if (wrapped !== geometryCols) return { ok: false, reason: `줄바꿈 폭 ${wrapped} ≠ DOM 기하 cols ${geometryCols}` };
  return { ok: true, reason: `줄바꿈 폭 = cols = ${wrapped}` };
}
