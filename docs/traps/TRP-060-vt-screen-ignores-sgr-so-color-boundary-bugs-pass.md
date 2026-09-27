# TRP-060 `VtScreen`은 SGR을 무시하므로 색 경계 결함은 화면 단정으로 보이지 않는다

- 상태: ACTIVE
- 적용 조건: `@repo/pyodide-testkit/vt-screen`의 `VtScreen`(또는 같은 방식의 가상 화면)으로 결과 화면을 단정하는 시험에서, 조각 사이 `\x1b[0m`·프롬프트 앞 SGR 초기화처럼 색 경계가 계약인 경로를 확인할 때(접두·꼬리 복원, 프롬프트 합성, stderr 빨강 조각).

## 오해하기 쉬운 신호

- 화면 시험이 전부 GREEN이다. 예: `runSource` 브리지가 접두와 읽기 시작 꼬리를 `${prefix}${openTail}\x1b[0m\r\n`으로 복원해 접두가 연 빨강(`\x1b[31mt`)이 꼬리 `a`로 번졌는데 `vt.screen() === "ta"` 단정은 통과했다.
- 변이 검사도 글자 모양 변이만 넣으면 살아남는 변이가 없어 검출력이 충분해 보인다.

## 원인

`VtScreen.write`는 SGR(`m`)을 "글자에 영향이 없다"로 버린다. 셀마다 속성을 두는 모델이 없다.

## 탐지/회피

- 색 경계가 계약인 경로는 가짜 터미널의 쓰기 바이트(`fake.written`)를 `toContain`으로 단정한다. 예: `packages/pyodide-repl/test/create-repl/run-source.test.ts` "색이 열린 접두를 복원할 때는 벤더가 그린 대로 접두 뒤에서 색을 닫고 꼬리를 잇는다".
- 변이 목록에 "색 닫기 제거"(`\x1b[0m` 삭제) 변이를 넣어 바이트 단정이 잡는지 확인한다.
