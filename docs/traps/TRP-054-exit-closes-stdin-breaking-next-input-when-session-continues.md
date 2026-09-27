# TRP-054 `exit()`·`quit()`은 `sys.stdin`을 닫아, 세션이 이어지는 실행 경로의 다음 `input()`이 `ValueError`가 된다

- 상태: ACTIVE
- 적용 조건: `SystemExit`(특히 `exit()`·`quit()`) 뒤에 같은 pyodide 인스턴스에서 코드를 이어 실행하는 경로. REPL `runSource`, run마다 stdin을 새로 열지 않는 새 실행 경로, 한 pyodide로 여러 시험을 이어 돌리는 하니스.

## 오해하기 쉬운 신호

- `exit()` 실행 자체는 정상이다: 결말 `exit{ code: 0 }`, 출력 없음, 세션 유지. 다음 실행이 `input()`을 부를 때야 `error{ errorType: "ValueError" }`(`ValueError: I/O operation on closed file.`)로 드러난다.
- `sys.exit(3)`은 stdin을 닫지 않으므로 그것만으로 "세션 유지"를 시험하면 통과한다.

## 원인

`_sitebuiltins.Quitter.__call__`(`exit`·`quit`의 실체)이 `SystemExit`를 올리기 전에 `sys.stdin.close()`를 부른다. 평소 명령의 `exit()`는 세션이 끝나 상관없고 runner는 run마다 stdin을 새 `TextIOWrapper`로 교체하지만(`docs/design/14-runner.md` 14.2.2), `SystemExit`가 결말이고 세션이 이어지는 REPL `runSource` 경로는 어느 쪽도 아니다. 그래서 `exec_in_console`이 되살린다.

## 탐지/회피

- 되살림 규칙은 core `run-driver.py` `exec_in_console`의 `SystemExit` 분기 하나다(`docs/design/14-runner.md` 14.2.2).
- 세션 유지 시험은 `exit()`(코드 0)와 `sys.exit(3)` 둘 다 돌리고 뒤이은 `input()`까지 확인한다. `TRP-010`(`read(n)`이 남긴 `\n`)과는 다른 문제다.
- 시험: core `run-driver-exec-in-console.test.ts` `[S1]`~`[S5]`, `packages/pyodide-repl/test/worker/run-source.test.ts`의 stdin 절, 브라우저 `apps/demo/e2e/checks/run-source-check.mjs` S07.
