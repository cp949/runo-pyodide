# TRP-037 `vitest list --json`은 `test.each`·`describe.each`를 펼치지 않아 제목 목록 diff가 행 수 감소를 놓친다

- 상태: ACTIVE
- 적용 조건: 시험을 파일·패키지 사이로 옮기면서 "이동 전후 시험 제목 목록"을 `vitest list --json`으로 추출해 비교할 때.

## 오해하기 쉬운 신호

- 제목 목록 diff가 비어 있어 시험이 하나도 안 사라졌다고 읽는다. `test.each`의 행 하나가 빠져도 목록은 그대로다.
- 목록 항목 수가 실제 시험 수보다 훨씬 적다. 이동 시점 실측 예: repl `vitest list` 775 대 `pnpm test` 실제 1185, xterm-readline 155 대 160. 제목에 `$mode` 같은 템플릿이 그대로 남는다.
- 옮긴 시험의 이름·`describe` 경로를 바꾸면 목록에서는 삭제 1 + 추가 1로 잡히고, 파일만 옮기면 제목만 비교하는 목록에는 보이지 않는다.

## 원인

`vitest list`는 파일을 수집하기만 하고 시험을 실행하지 않는다. 실행 시점에 결정되는 `each` 행은 펼치지 못한다.

## 탐지/회피

- 두 수치를 이동 전후 모두 기록해 비교한다. 목록 수 외에 `pnpm test` 실행 합계(패키지별 시험 수)도 본다.

  ```bash
  cd packages/<패키지> && pnpm exec vitest list --json | jq -r '.[] | [.file, .name] | @tsv' | LC_ALL=C sort
  pnpm test   # 패키지별 "Tests  N passed"
  ```

- 제목만 비교하는 목록과, 파일 경로를 포함한 목록을 둘 다 만든다. 전자는 삭제·이름 변경을, 후자는 경로 이동을 보여 준다.
- 옮기는 시험은 같은 `describe`·`it` 이름으로 둔다. 이름이 바뀌면 diff에 삭제로 나타난다.
- `describe.each`의 제목에 `$mode` 같은 템플릿이 있으면 `vitest list | sort -u`는 모드별 같은 시험을 한 줄로 합친다. 새 시험을 두 모드로 더해도 목록 줄 수는 절반만 늘고, 한 모드 행만 사라져도 "사라진 제목 0"이 나온다. 새 시험 수는 `Tests N passed` 전후 차이로 맞추고, 모드 행 변경은 `git diff`에서 `each` 배열을 본다.
