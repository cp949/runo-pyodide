// Tab 처리의 계산 부분을 상태 없는 순수 함수로 둔다. 3.14 `_pyrepl` 규칙을 옮긴 것이다
// (docs/design/07-tab-completion.md 7.2~7.4). worker·xterm-readline 의존이 없어 vitest로
// 단정하기 쉽다 — 키 입력 배선과 pyodide 호출은 이 모듈을 부르기만 한다.
//
// 코드포인트/UTF-16 경계: `buf`·`source`는 JS 문자열(UTF-16 코드 유닛)이지만 worker가 돌려주는
// `start`는 Python `str` 인덱스(코드포인트)다. 이모지 같은 서로게이트 쌍이 스템 앞에 있으면 두
// 인덱스가 어긋나므로, 스템을 자를 때는 `[...str]`로 코드포인트 배열을 만든 뒤 `slice`한다.
// UTF-16 `str.slice`를 그대로 쓰면 서로게이트 쌍이 반으로 잘려 깨진 문자가 남는다(TRP-031).

// 스템 구분자: pyodide `Console.completer_word_break_characters`와 같은 33자.
const STEM_DELIMITERS = ` \t\n\`~!@#$%^&*()-=+[{]}\\|;:'",<>/?`;

// 공백 삽입의 탭 정지 간격. 3.14 `_pyrepl`이 스템이 빈 곳에서 넣는 폭과 같다.
const TAB_STOP = 4;

// 목록에 나열하는 후보 상한. 넘는 후보는 "...N개 더" 한 행으로 줄인다.
const LIST_CAP = 200;

// 열 사이 간격. 셀 폭 = 최장 후보(코드포인트 길이) + 간격.
const CELL_GAP = 2;

export type TabPlan =
  { kind: "indent"; text: string } | { kind: "complete"; source: string };

// import·from 사전 게이트. 부분 문자열이고 단어 경계가 없다(TRAP-33): `\b`를 쓰면 `1import os` 류에서
// 게이트가 거짓인데 3.14 파서는 후보를 내 결과가 어긋난다. 필요조건("키워드 글자열이 있어야 한다")만
// 봐서 건전하다. 대가는 `important = ` 같은 식별자 안 키워드 줄의 빈 스템 왕복 1회다(worker가 None으로 판정).
export function mentionsImportKeyword(text: string): boolean {
  return /import|from/.test(text);
}

// Tab을 눌렀을 때 공백을 넣을지 완성을 요청할지 커서 앞 텍스트만으로 정한다. 스템은 커서가 있는
// 논리 줄(마지막 `\n` 뒤)에서 마지막 구분자 뒤이고, 커서 뒤 텍스트는 보지 않는다. 스템이 비면
// (줄이 비었거나 마지막 글자가 구분자) 다음 4칸 단위 위치까지 공백을 넣는다 — 열은 논리 줄 안
// 위치로 세고 `\t`도 1칸으로 센다. 단, `pending`(이전 줄 블록)과 커서 앞 텍스트를 `\n`으로 이은
// 문맥에 import·from 글자열이 있으면 스템이 비어도 완성을 요청한다(worker가 모듈 후보 또는 공백
// 후보로 판정한다, 7.5). 스템이 있으면 항상 `source`(커서 앞 전체 텍스트)로 완성을 요청한다.
export function planTab(buf: string, pos: number, pending?: string): TabPlan {
  const source = buf.slice(0, pos);
  const line = source.slice(source.lastIndexOf("\n") + 1);
  // `.at(-1)`(Chrome 92+)은 빌드 floor Chrome 84를 넘는다(ADR-0008) — 인덱스 접근으로 대체한다.
  if (line === "" || STEM_DELIMITERS.includes(line[line.length - 1] ?? "")) {
    const context = pending ? `${pending}\n${source}` : source;
    if (mentionsImportKeyword(context)) return { kind: "complete", source };
    const column = [...line].length;
    return { kind: "indent", text: " ".repeat(TAB_STOP - (column % TAB_STOP)) };
  }
  return { kind: "complete", source };
}

export interface ResolveCompletionInput {
  buf: string;
  pos: number;
  // 직전 키도 Tab이었는가. 두 번째 연속 Tab일 때만 목록을 연다.
  second: boolean;
  completions: string[];
  // worker가 돌려준, 스템이 시작하는 코드포인트 인덱스(Python `str` 기준, JS 인덱스가 아니다).
  start: number;
}

export type CompletionAction =
  | { kind: "none" }
  | { kind: "insert"; text: string }
  | { kind: "list"; completions: string[]; stem: string };

// 후보로 무엇을 할지 정한다. 삽입은 공통 접두사에서 스템을 뺀 나머지를 커서 위치에 넣는 것이고
// (후보 하나면 그 후보 전체가 공통 접두사), 채울 것이 없을 때만 연속 두 번째 Tab이 목록을 연다.
// 후보 하나가 이미 입력과 같으면(채울 것이 없으면) 목록을 열지 않는다.
export function resolveCompletion({
  buf,
  pos,
  second,
  completions,
  start,
}: ResolveCompletionInput): CompletionAction {
  if (completions.length === 0) return { kind: "none" };
  // `start`는 코드포인트 인덱스라 UTF-16 `slice`로 자르면 이모지 뒤에서 스템이 밀린다.
  const stem = [...buf.slice(0, pos)].slice(start).join("");
  // 공통 접두사에서 스템을 뺀 나머지도 코드포인트 단위로 잘라야 한다. UTF-16 `slice`를 쓰면
  // 아스트랄 문자가 스템 길이 안에 걸칠 때 서로게이트 쌍이 반으로 잘려 깨진 문자가 남는다.
  const text = [...commonPrefix(completions)].slice([...stem].length).join("");
  if (text !== "") return { kind: "insert", text };
  if (completions.length > 1 && second)
    return { kind: "list", completions, stem };
  return { kind: "none" };
}

// 코드포인트 단위 공통 접두사. UTF-16 단위로 비교하면 서로게이트 쌍의 절반만 남을 수 있다.
function commonPrefix(items: string[]): string {
  const [first = [], ...rest] = items.map((item) => [...item]);
  let length = first.length;
  for (const chars of rest) {
    let i = 0;
    while (i < length && chars[i] === first[i]) i++;
    length = i;
  }
  return first.slice(0, length).join("");
}

// 코드포인트 단위 길이. 폭은 이 길이로 근사한다(전각 문자는 화면에서 2칸을 차지하지만 세지 않는다).
function codepointLength(text: string): number {
  return [...text].length;
}

// 두 번째 Tab의 목록을 3.14 `_pyrepl` 메뉴처럼 열 우선으로 배치한 행으로 만든다. 열 수는
// floor(터미널 열 / 셀 폭)이고(최소 1) 행 수는 ceil(후보 수 / 열 수)이다. 셀 인덱스는
// `row + k * rowCount`(왼쪽 열부터 위에서 아래로 채운다). 마지막 셀은 패딩하지 않는다(행 끝
// 공백 없음). `LIST_CAP`을 넘는 후보는 "...N개 더" 한 행으로 줄인다.
export function formatCompletionList(
  completions: string[],
  columns: number,
): string[] {
  const shown = completions.slice(0, LIST_CAP);
  const cellWidth = Math.max(...shown.map(codepointLength)) + CELL_GAP;
  const perRow = Math.max(1, Math.floor(columns / cellWidth));
  const rowCount = Math.ceil(shown.length / perRow);
  const rows: string[] = [];
  for (let row = 0; row < rowCount; row++) {
    const cells: string[] = [];
    for (let index = row; index < shown.length; index += rowCount)
      cells.push(shown[index] ?? "");
    rows.push(
      cells
        .map((cell, i) =>
          i < cells.length - 1
            ? cell + " ".repeat(cellWidth - codepointLength(cell))
            : cell,
        )
        .join(""),
    );
  }
  const remaining = completions.length - shown.length;
  if (remaining > 0) rows.push(`...${remaining}개 더`);
  return rows;
}
