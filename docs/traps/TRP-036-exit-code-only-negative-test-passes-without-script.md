# TRP-036 종료 코드만 단언한 "실패해야 한다" 시험은 대상 스크립트가 없어도 통과한다

- 상태: ACTIVE
- 적용 조건: CLI 스크립트를 자식 프로세스로 실행해 `status === 1`만 확인하는 부정 시험(`packages/pyodide-testkit/src/check-dist-script.test.ts`의 실패 케이스 등)을 쓸 때.

## 오해하기 쉬운 신호

- 시험이 통과한다. 스크립트 파일이 없거나 문법 오류로 죽어도 Node가 종료 코드 1을 내므로(`Cannot find module` / `MODULE_NOT_FOUND`) RED 확인에서 "실패해야 하는" 시험이 구현 없이 통과한다. 처음 작성한 9건 중 실패 케이스 5건이 그랬다.
- 통과한 시험이 "실패를 검출한다"가 아니라 "Node가 죽었다"를 보고 있다.

## 원인

Node의 모듈 해석 실패와 스크립트 자신의 검사 실패가 같은 종료 코드 1이다.

## 탐지/회피

- 스크립트가 스스로 실패했다는 표식 문자열을 함께 단언한다. `scripts/check-dist.mjs`는 `check-dist 실패: <사유>`를 stderr에 낸다.

  ```ts
  const FAIL_MARK = "check-dist 실패";
  expect(status, output).toBe(1);
  expect(output).toContain(FAIL_MARK);
  ```

- RED 확인은 대상 파일을 치워 실행해 부정 시험 전부가 실패하는지 본다(스크립트가 없을 때 통과하는 시험이 남아 있으면 표식 단언이 빠진 것이다).
