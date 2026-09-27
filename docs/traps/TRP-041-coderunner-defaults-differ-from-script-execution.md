# TRP-041 `CodeRunner` 기본값(`dedent=True`, `return_mode="last_expr"`)은 스크립트 실행과 달라 오류가 조용히 사라진다

- 상태: ACTIVE
- 적용 조건: `pyodide.code.CodeRunner`(또는 `eval_code`)로 "스크립트 한 파일"을 실행하는 코드(실행 driver, REPL `runSource`). pyodide 314.0.7 기준.

## 오해하기 쉬운 신호

- 들여쓴 첫 줄(`  x = 1`)이 `IndentationError` 없이 실행된다. CPython은 `unexpected indent`다.
- 마지막 식은 값을 돌려주므로 `print` 없이도 결과가 생긴다. 일반 코드에서는 차이가 보이지 않아 시험이 통과한다.

## 원인

- `CodeRunner`의 기본 `dedent=True`(소스를 `textwrap.dedent`로 정리)와 `return_mode="last_expr"`(마지막 식을 raise로 바꿈)가 REPL·`eval_code`용 기본값이다.
- `dont_inherit=False`는 호출 모듈의 `__future__` 플래그를 물려받게 할 수 있다. pyodide 314.0.7의 `_base.py`·`console.py`에는 `__future__`가 없어 지금은 결과가 같다.

## 탐지/회피

- `mode="exec", return_mode="none", dedent=False, dont_inherit=True`로 만든다(`run-driver.py`). 시험은 `"  x = 1"`이 `unexpected indent`인지 본다(`run-driver-pyodide.test.ts`, `dedent` 기본값 변이가 이 시험에서 죽는다).
- `return_mode`·`dont_inherit`를 기본값으로 되돌리는 변이는 관찰 가능한 차이가 없어 살아남는다(동등 변이·방어 코드). pyodide를 올릴 때 `__future__` 사용 여부를 다시 본다.
