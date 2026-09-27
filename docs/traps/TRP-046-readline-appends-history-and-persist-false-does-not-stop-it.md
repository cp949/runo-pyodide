# TRP-046 벤더 `Readline`은 Enter마다 history에 append하고 건너뛸 방법이 없다 — `persist: false`는 저장만 끈다

- 상태: ACTIVE
- 적용 조건: `Readline.read()`로 한 줄을 받으면서 그 줄을 history에 남기고 싶지 않은 모든 소비자(실행창의 `input()` 읽기, 향후 React 래퍼).
- 갱신(2026-09-26): 벤더에 읽기 단위 옵션 `ReadOptions.history?: false`를 더했다. 제목의 "건너뛸 방법이 없다"는 원본 1.2.2와 그 시점 벤더 기준이다. `persist: false`가 history를 끈 것으로 읽는 신호는 그대로 남는다.

## 오해하기 쉬운 신호

- `persist: false`가 history를 끈 것처럼 읽힌다. 실제로는 localStorage 저장만 끄고 메모리 history는 그대로 쌓인다. `skipBlankHistory`는 공백뿐인 제출만 거르고, `ReadOptions.historyEntry`는 기록할 문자열을 바꿀 뿐 항목을 건너뛰지 못한다(빈 문자열도 기록된다).
- ↑를 눌러야 드러나므로 Enter만 치는 시험은 통과한다.

## 원인

- 벤더 `readline.ts`의 Enter 분기가 `history.append(...)`를 무조건 부른다(`skipBlankHistory` 예외만).

## 탐지/회피

- 기록하지 않을 읽기는 `readline.read(prompt, { history: false })`로 연다(Enter 제출을 append하지 않고 `historyEntry`도 부르지 않는다). 실행창 `readInput`은 `promptRow.read("", { cancelable: true, signal, history: false })`(RD-027, 구 `inputReader.read(true, signal, { history: false })`)로 연다.
- 2026-09-26 전 회피: 읽기 앞에 `readline.getHistory().entries.slice()`를 잡고 읽기가 끝난 뒤(정상·취소·예외 모두 `finally`) `history.restore(snapshot)`로 되돌렸다(`terminal-runner.ts`의 `readInput`, RD-014의 블록 히스토리와 같은 방식). 그때는 벤더에 "기록 안 함" 옵션을 넣지 않았다.
- 시험: `terminal-runner.test.ts`의 "Enter로 제출한 입력줄은 history에 남지 않아 다음 읽기에서 ↑로 되살아나지 않는다"(↑로 확인, `history: false` 전환 뒤에는 `readInput`이 `{ history: false }`를 넘기지 않는 변이가 이 시험에서 죽는다), 벤더 `history-entry.test.ts` "history: false 읽기 옵션".
