// RD-023 DELTA-04: dom-bridge-check의 판정 함수. 브라우저 없이 가짜 입력으로 시험할 수 있게 순수 함수로 분리했다
// (`dom-bridge-judge.test.mjs`, 양성 대조). 시간 값은 받지 않는다: 판정은 `?view=dom-bridge`가 남기는 이벤트 열(`window.__domBridge.events`)의
// 앞뒤·화면 행·상태 전이만 본다(`docs/design/09-testing.md` 9.7).
//
// 이벤트 모양(`apps/demo/src/dom-bridge-log.ts`): `{ type, data }`. `type`은 `runStart`·`outcome`(`data` = 결과 유니온)·`out`(`data` =
// `{ stream, text }`)·`status`(`data` = 상태 문자열)·`dom`(`data` = `<title>` 문자열)·`slowStart`·`slowDone`(`data` = `{ id, ms }`).

/**
 * traceback 문자열에서 사용자 코드(`main.py`) 마지막 프레임의 줄 번호. 없으면 `null`.
 */
export function userLine(traceback) {
  const lines = [...String(traceback ?? "").matchAll(/File "main\.py", line (\d+)/g)];
  return lines.length === 0 ? null : Number(lines[lines.length - 1][1]);
}

/**
 * 출력·DOM 쌍의 도착 순서. Python이 `print(f"p{i}", flush=True)` 직후 `document.title = f"d{i}"`를 `iters`번 반복한 실행 하나의 이벤트 열
 * (실행 시작부터 결말까지)을 받아, i마다 출력(`o{i}`)이 title 변경(`d{i}`)보다 먼저 도착했는지 센다. 역전 = d{i}가 o{i}보다 먼저.
 * 누락 = 둘 중 하나가 없음. 출력 청크 하나에 여러 줄이 들어올 수 있어 청크 안의 `p<숫자>`를 전부 센다.
 * @returns {{ pairs: number, inversions: number, missing: number }}
 */
export function judgeOrder(events, iters) {
  const seq = [];
  for (const e of events) {
    if (e.type === "out") {
      for (const m of String(e.data?.text ?? "").matchAll(/\bp(\d+)\b/g)) seq.push(`o${m[1]}`);
    } else if (e.type === "dom") {
      const m = /^d(\d+)$/.exec(String(e.data));
      if (m) seq.push(`d${m[1]}`);
    }
  }
  let inversions = 0;
  let missing = 0;
  for (let i = 0; i < iters; i += 1) {
    const o = seq.indexOf(`o${i}`);
    const d = seq.indexOf(`d${i}`);
    if (o < 0 || d < 0) missing += 1;
    else if (d < o) inversions += 1;
  }
  return { pairs: iters, inversions, missing };
}

/**
 * S5: 동기 coincident 호출 도중 중단 요청의 결말이 호출이 반환된 **뒤**에 왔는가. `events`는 실행 시작부터 결말 뒤까지의 열이고 `id`는
 * 그 호출의 `slowStart`·`slowDone` id다. 결말(`outcome`)이 `slowDone`보다 뒤여야 통과다(앞이면 호출 도중에 전달된 것이라 스파이크 판정과 다르다).
 * `expectKind`가 있으면 결말 종류도 맞아야 한다. `slowDone`이 없으면(호출이 끝나기 전에 결말이 왔거나 호출이 시작되지 않음) 실패다.
 * `requestType`(`ctrlC`·`stop` 이벤트)이 있으면 그 중단 요청이 `slowStart`와 `slowDone` 사이(호출 도중)에 들어갔어야 한다: 호출이 끝난 뒤에 눌렀다면
 * "호출 반환 뒤에 결말"은 당연한 결과라 시험이 성립하지 않는다.
 * @returns {{ ok: boolean, reason: string }}
 */
export function judgeAfterCallReturn(events, id, expectKind, requestType) {
  const start = events.findIndex((e) => e.type === "slowStart" && e.data?.id === id);
  if (start < 0) return { ok: false, reason: `slowStart(id ${id})가 없다` };
  const done = events.findIndex((e) => e.type === "slowDone" && e.data?.id === id);
  const outcome = events.findIndex((e, i) => i > start && e.type === "outcome");
  if (outcome < 0) return { ok: false, reason: "결말(outcome)이 없다" };
  if (done < 0 || outcome < done) {
    return { ok: false, reason: `결말이 호출 도중에 왔다(outcome #${outcome}, slowDone ${done < 0 ? "없음" : `#${done}`})` };
  }
  if (requestType !== undefined) {
    const request = events.findIndex((e, i) => i > start && e.type === requestType);
    if (request < 0) return { ok: false, reason: `중단 요청(${requestType}) 기록이 없다` };
    if (request > done) return { ok: false, reason: `중단 요청(${requestType} #${request})이 호출 반환(slowDone #${done}) 뒤에 들어갔다: 시험 불성립` };
  }
  const kind = events[outcome].data?.kind;
  if (expectKind !== undefined && kind !== expectKind) return { ok: false, reason: `결말 kind = ${kind}(기대 ${expectKind})` };
  return { ok: true, reason: `slowDone #${done} → outcome #${outcome}(${kind})` };
}

/**
 * S5 stop 셀: 동기 호출 도중 누른 `stop()`의 결말(`outcome`, kind `restarted`)이 옛 호출이 끝나기(`slowDone`) **전에** 왔는가. `events`는 실행 시작부터
 * 판정 시점까지의 열이고 `id`는 그 호출의 `slowStart`·`slowDone` id다. 성립 조건: `slowStart` 뒤 첫 결말이 `restarted`이고, 그 앞에 `stop` 요청이 있으며,
 * 그 id의 `slowDone`이 없거나 결말보다 뒤다. 판정 시점(새 worker `ready` 뒤 등)에 `slowDone`이 이미 기록됐는지는 보지 않는다: 재부팅 시간이 길면 결말 뒤
 * `slowDone`이 먼저 기록될 수 있고, 그 경우도 순서상 성립이다(재부팅 시간을 판정선으로 쓰지 않는다, 9.7).
 * @returns {{ ok: boolean, reason: string }}
 */
export function judgeStopBeforeCallReturn(events, id) {
  const start = events.findIndex((e) => e.type === "slowStart" && e.data?.id === id);
  if (start < 0) return { ok: false, reason: `slowStart(id ${id})가 없다` };
  const outcome = events.findIndex((e, i) => i > start && e.type === "outcome");
  if (outcome < 0) return { ok: false, reason: "결말(outcome)이 없다" };
  const kind = events[outcome].data?.kind;
  if (kind !== "restarted") return { ok: false, reason: `결말 kind = ${kind}(기대 restarted)` };
  const stop = events.findIndex((e, i) => i > start && e.type === "stop");
  if (stop < 0 || stop > outcome) return { ok: false, reason: `결말 #${outcome} 앞에 stop 요청 기록이 없다` };
  const done = events.findIndex((e) => e.type === "slowDone" && e.data?.id === id);
  if (done >= 0 && done < outcome) {
    return { ok: false, reason: `옛 slow가 결말 전에 끝났다(slowDone #${done} → outcome #${outcome}): 호출 도중 종료가 아니라 시험 불성립` };
  }
  return { ok: true, reason: `stop #${stop} → outcome #${outcome}(restarted), slowDone ${done < 0 ? "아직 없음" : `#${done}(결말 뒤)`}` };
}

/**
 * `events`(status 이벤트 포함)의 `from` 이후 status 전이가 `wanted`를 이 순서로 부분 수열로 포함하는가. 예: `["restarting", "ready"]`.
 * @returns {{ ok: boolean, seen: string[] }}
 */
export function judgeStatusSubsequence(events, from, wanted) {
  const seen = events.slice(from).filter((e) => e.type === "status").map((e) => String(e.data));
  let next = 0;
  for (const s of seen) if (next < wanted.length && s === wanted[next]) next += 1;
  return { ok: next === wanted.length, seen };
}

/** 화면 행 목록을 공백 없이 이어붙인 문자열. 긴 문구는 80열에서 감기고(한글 2열) 감기는 위치의 공백이 사라질 수 있어 공백을 뺀 채 비교한다. */
export function squashRows(rows) {
  return rows.join("").replace(/\s/g, "");
}

/**
 * `load-failed` 화면 문구 판정. 터미널은 `pyodide 로드 실패: <메시지>`를 내고 메시지는 `Error: plugin "<이름>": <원인>`이다(core `bootWorker`가
 * `String(error)`로 통지하므로 `Error: ` 접두가 붙는다). 접두 `pyodide 로드 실패: Error: plugin "<이름>": `과 원인 문구(`phrases`) 전부를 요구한다.
 * @returns {{ ok: boolean, reason: string }}
 */
export function judgeLoadFailedRows(rows, pluginName, phrases) {
  const text = squashRows(rows);
  const prefix = squashRows([`pyodide 로드 실패: Error: plugin "${pluginName}": `]);
  const at = text.indexOf(prefix);
  if (at < 0) return { ok: false, reason: `접두 ${JSON.stringify(prefix)}가 없다: ${JSON.stringify(text.slice(0, 200))}` };
  const rest = text.slice(at + prefix.length);
  for (const phrase of phrases) {
    const p = squashRows([phrase]);
    if (!rest.includes(p)) return { ok: false, reason: `원인 문구 ${JSON.stringify(phrase)}가 없다: ${JSON.stringify(rest.slice(0, 200))}` };
  }
  return { ok: true, reason: "접두와 원인 문구가 있다" };
}

/** S6이 측정하는 DOM 효과 방식: C(`document.title` 대입 + MutationObserver 기록), Ag(guarded `window`로 main 함수 호출), Ar(가드 없는 창으로 호출). */
export const ORDER_METHODS = ["C", "Ag", "Ar"];

/**
 * S6 경로 하나(core `createRunner` 직접 또는 `<PythonRunner>` + terminal)의 출력·DOM 도착 순서 판정. `methods`는 방식(`C`·`Ag`·`Ar`)별
 * `{ pairs, inversions, missing, outcomes }`(`outcomes`는 실행별 결말 `kind`)다. 필수는 세 방식이 모두 있고, 쌍이 있으며, 기록 누락 0·모든 실행 `ok`인 것이다.
 * **역전 수는 어느 경로·방식이든 판정하지 않고 `summary`·`reason`에 기록만 한다**(사용자 재확정 2026-09-25: 출력은 core MessagePort, DOM 호출은 coincident
 * 채널로 가서 두 채널 사이의 도착 순서는 보장되지 않는다. 관측 수치는 `.scratch/dom-bridge-followups/issues/03-output-dom-arrival-order-inversion.md`).
 * @returns {{ ok: boolean, reason: string, summary: Record<string, { pairs: number, inversions: number, missing: number }> }}
 */
export function judgeOrderPath(methods) {
  const summary = {};
  for (const name of ORDER_METHODS) {
    const m = methods?.[name];
    if (!m) return { ok: false, reason: `방식 ${name}의 측정이 없다`, summary };
    summary[name] = { pairs: m.pairs, inversions: m.inversions, missing: m.missing };
  }
  for (const name of ORDER_METHODS) {
    const m = methods[name];
    if (!(m.pairs > 0)) return { ok: false, reason: `${name}: 쌍이 없다`, summary };
    if (m.missing !== 0) return { ok: false, reason: `${name}: 기록 누락 ${m.missing}/${m.pairs}`, summary };
    if (!Array.isArray(m.outcomes) || m.outcomes.length === 0 || m.outcomes.some((k) => k !== "ok")) {
      return { ok: false, reason: `${name}: 모든 실행이 ok가 아니다(${JSON.stringify(m.outcomes)})`, summary };
    }
  }
  const text = ORDER_METHODS.map((n) => `${n} ${summary[n].inversions}/${summary[n].pairs}`).join(", ");
  return { ok: true, reason: `누락 0·모든 ok, 역전 수(판정 없음, 기록) ${text}`, summary };
}
