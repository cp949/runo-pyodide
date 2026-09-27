# RD-016a DELTA-01 3.14 실측 재현 (import/from 줄 Tab 완성)

- 측정 일자: 2026-09-21. 기준: CPython 3.14.4(네이티브 pty·직접 호출) 대 pyodide 314.0.7(Python 3.14.2, Node).
- 이 파일은 `make_summary.py`가 JSON에서 생성한다. 원자료: `res_import.json`(A), `native_vs_pyodide.json`(B), `gate_corpus.json`(C).

## 1. 결론

- 케이스 수: 측정 A 37(+추가 4), 측정 B 95, 측정 C 53. 모두 DELTA-01 계획 이상.
- 기대값 49항목 중 일치 43, 불일치 6. 후보·화면 기대값은 전부 재현됐다. 불일치는 측정 B 카운트 5항목(사전 조사의 65케이스 줄 목록이 저장되지 않아 케이스 집합이 다름)과
  네이티브 전용 밑줄 모듈 17개(기대 목록에 없음) 1항목이다. 7절.
- 측정 B: 95케이스 중 동일 75, 차이 20(환경 모듈 집합 16, zip stdlib 로직 4, 기타 0). `ImportParser` 파싱 결과는 95줄 전부 네이티브와 pyodide가 같다(불일치 0).
- 측정 C: 게이트(`/\b(import|from)\b/`)가 거짓인 30줄 중 네이티브가 `None`이 아닌 예외 5줄:
  전부 숫자 리터럴 바로 뒤에 `import`/`from`이 붙은 입력(`1import os`)이다. 게이트 참·`None`(오탐) 17줄.

### 사전 조사 기대값과 달라서 설계에 영향이 있는 관찰

1. **후보가 cwd에 의존한다.** REPL의 `sys.path[0]`가 `''`라 `ModuleCompleter`가 cwd의 `.py` 파일·패키지를 모듈 후보로 나열한다. 하니스 폴더에서 pty를 띄우면 `import ` 후보가 192개가 아니라 196개
   (`common`·`hook_startup`·`ptyrepl`·`runcases_import` 추가)가 된다. 이 하니스는 자식 REPL의 cwd를 빈 임시 폴더로 고정해 192개를 얻는다. pyodide는 `sys.path[0] == ''`, cwd `/home/pyodide`이므로
   MEMFS cwd의 파일도 후보에 섞이는 것이 3.14와 같은 동작이다. 시험은 후보 개수·전체 목록을 단정하지 말 것.
2. **삽입 규칙은 `후보[len(스템):]`이고 스템은 `get_stem()`(구분자 기반)이다. 파싱 결과와 스템이 어긋나면 3.14 자체가 이상한 삽입을 한다.**
   `import os.pa  # c` Tab -> `import os.pa  # cs.path`, `from os import path,` Tab -> `from os import path,path`, `import os.pa\n` Tab -> 둘째 줄에 `os.path`, `import os  # c\n` Tab -> 둘째 줄에 `os`. 4절 표.
3. **zip stdlib 차이는 4줄이다**(기대는 2줄). `from xml.parsers.expat import `, `import xml.parsers.expat.`도 pyodide에서 `[]`이다. 원인은 같다(`_is_stdlib_module`이 `FileFinder`만 stdlib로 인정해
   `zipimporter`인 pyodide에서 `HARDCODED_SUBMODULES`가 빠진다). 참고 진단: `_is_stdlib_module`만 오버라이드한 서브클래스로 4줄이 네이티브와 같아지고 퇴행 0줄
   (`pyodide_zip_patch_check.json`; 채택 여부는 DELTA-02a에서 판단).
4. **`sys.modules`는 변하지 않는다.** 측정 B 95줄·C 53줄 실행 전후 추가·삭제 모듈 0개(네이티브·pyodide 모두). 설계 Q4 전제 확인.
5. **`ModuleCompleter()`와 `ModuleCompleter(namespace={'__package__': None})`(pty가 쓰는 `make_default_module_completer()`)는 95+53줄에서 결과가 같다**(네이티브·pyodide 모두 차이 0줄).
   pty 훅의 `mc`(ModuleCompleter 원시 결과)와 측정 B 네이티브 직접 호출 결과도 A 37줄 + 추가 4줄에서 전부 같다.

## 2. 재현 명령

전제: `python3.14`(3.14.4), `node`(v24.20.0, nvm 경로를 `NODE`로 지정), `jq`(`/usr/bin/jq`). PATH가 최소인 새 셸에서도 그대로 실행된다. pty 측정 A는 약 5분이 걸린다.

```bash
PY=/home/jjfive/.local/bin/python3.14
NODE=/home/jjfive/.nvm/versions/node/v24.20.0/bin/node
cd /work/cp949/pyodide-samples/_works/20260921-01-rd-016a-import-completion/reference/measure-3.14

# 측정 B: 네이티브 대 pyodide  -> native_vs_pyodide.json(+ .meta.json)
$PY make_lines_B.py && $PY native_complete.py && $NODE pyodide_complete.mjs && $PY compare_native_pyodide.py

# 측정 C: 게이트 코퍼스  -> gate_corpus.json(+ .meta.json)
$PY make_lines_C.py && $NODE gate_js.mjs lines_C.json gate_js_C.json \
  && $PY native_complete.py lines_C.json native_result_C.json \
  && $NODE pyodide_complete.mjs lines_C.json pyodide_result_C.json && $PY build_gate_corpus.py

# 측정 A: pty 화면 실측  -> res_import.json, res_import_extra.json (부분 실행: 그룹 뒤에 시작 끝 인덱스)
$PY runcases_import.py import
$PY runcases_import.py import_extra

# 참고 진단(zip stdlib 오버라이드), 기대값 대조, 이 문서 재생성
$NODE pyodide_zip_patch_check.mjs && $PY verify_expectations.py && $PY make_summary.py

# 케이스 수 확인
jq length res_import.json native_vs_pyodide.json gate_corpus.json
```

## 3. 하니스와 재현성

- `python3.14`는 `/home/jjfive/.local/bin/python3.14` -> `/tmp/claude-1000/.../e3ab0d65-.../scratchpad/uvpy/cpython-3.14.4-linux-x86_64-gnu/bin/python3.14` 심볼릭 링크다. **이전 세션 `/tmp` scratchpad가 지워지면 링크가 깨진다**
  (링크 대상은 uv 관리 CPython 3.14.4). 다른 인터프리터를 쓰려면 `PY314=<경로>`(`ptyrepl.py`가 읽음)와 위 `PY`를 바꾼다. 3.14.4가 아니면 결과가 달라질 수 있다.
- `pyte` 0.8.2·`wcwidth` 0.8.4는 이 폴더 `pylib/`에 복사했다(`ptyrepl.py`가 `sys.path`에 넣는다. 이전 세션 scratchpad `pylib` 사본). 자식 REPL에는 노출되지 않는다.
- pyodide는 `/work/cp949/pyodide-samples/apps/repl/node_modules/pyodide`(314.0.7)를 절대 경로로 import한다. `pnpm install` 상태에 의존한다.
- 원본 하니스(`_works/_completed/20260920-04-rd-016-tab-completion/reference/measure-3.14/`) 대비 변경(복사본만): `ptyrepl.py` `pylib` 경로·`PY314` 환경 변수·자식 cwd를 빈 임시 폴더로 고정, `hook_startup.py`에 `mc` 필드
  (ModuleCompleter 원시 결과) 추가. 원본은 수정하지 않았다.
- pty 조건: 24x80, `TERM=xterm`, `PYTHON_COLORS=0`, 임시 `HOME`·`PYTHON_HISTORY`, 케이스마다 새 세션에서 SETUP 5줄(`import os` 등) 실행 뒤 Ctrl+L. 다중 줄 입력은 bracketed paste. Tab 사이 대기 0.5초(pyte 렌더링 정착).
- 측정 B·C의 네이티브 실행은 REPL과 같은 조건이다: `sys.path[0] = ''`(스크립트 폴더 아님), 빈 임시 cwd. pyodide는 `loadPyodide()` 기본 상태(cwd `/home/pyodide` 비어 있음).
- 시각·경로 의존 필드: `native_vs_pyodide.meta.json`, `gate_corpus.meta.json`, `native_result*.json`의 `cwd`는 실행마다 임시 경로가 다르다. 그 외 결과 JSON은 결정적이다(B·C는 재실행 후 바이트 단위 동일 확인).
- pyodide 번들은 Python 3.14.2, 기준 pty는 3.14.4다. 이 측정에서 파서 결과는 95줄 전부 같았고 후보 차이는 5절 분류 안에서 설명된다. 3.14.2 대 3.14.4 소스 차이 자체는 이 측정으로 배제되지 않는다.

## 4. 측정 A: pty 화면 실측 (37케이스)

`MC` = hook이 다시 호출한 `get_module_completions()` 원시 결과(None = 폴백, `[]` = 무동작, list = 후보). `res` = 최종 후보(폴백 포함). `삽입` = Tab 1회 뒤 커서 이동 칸 수. 화면은 Tab 1회 뒤 커서 줄부터 아래.

| ID  | 입력 (Tab)                                | 스템              | MC        | res                                                                  | 삽입 | Tab 뒤 화면                                                          |
| --- | ----------------------------------------- | ----------------- | --------- | -------------------------------------------------------------------- | ---- | -------------------------------------------------------------------- |
| A01 | `'import os.pa'` (1)                      | `'os.pa'`         | list(1)   | ['os.path'] (1)                                                      | +2   | `>>> import os.path`                                                 |
| A02 | `'from os import pa'` (1)                 | `'pa'`            | list(1)   | ['path'] (1)                                                         | +2   | `>>> from os import path`                                            |
| A03 | `'import o'` (1)                          | `'o'`             | list(4)   | ['opcode', 'operator', 'optparse', 'os'] (4)                         | +0   | `>>> import o / [ not unique ]`                                      |
| A04 | `'from o'` (1)                            | `'o'`             | list(4)   | ['opcode', 'operator', 'optparse', 'os'] (4)                         | +0   | `>>> from o / [ not unique ]`                                        |
| A05 | `'import xml.dom.m'` (1)                  | `'xml.dom.m'`     | list(2)   | ['xml.dom.minicompat', 'xml.dom.minidom'] (2)                        | +3   | `>>> import xml.dom.mini / [ not unique ]`                           |
| A06 | `'from xml.dom import m'` (1)             | `'m'`             | list(2)   | ['minicompat', 'minidom'] (2)                                        | +3   | `>>> from xml.dom import mini / [ not unique ]`                      |
| A07 | `'import os, sy'` (1)                     | `'sy'`            | list(4)   | ['symtable', 'sys', 'sysconfig', 'syslog'] (4)                       | +0   | `>>> import os, sy / [ not unique ]`                                 |
| A08 | `'import os as o, sy'` (1)                | `'sy'`            | list(4)   | ['symtable', 'sys', 'sysconfig', 'syslog'] (4)                       | +0   | `>>> import os as o, sy / [ not unique ]`                            |
| A09 | `'import collections.a'` (1)              | `'collections.a'` | list(1)   | ['collections.abc'] (1)                                              | +2   | `>>> import collections.abc`                                         |
| A10 | `'from collections import a'` (1)         | `'a'`             | list(1)   | ['abc'] (1)                                                          | +2   | `>>> from collections import abc`                                    |
| A11 | `'import '` (2)                           | `''`              | list(192) | ['abc', 'annotationlib', 'antigravity', 'argparse', …] (192)         | +0   | `>>> import / [ not unique ] ; Tab2: 메뉴 22줄(끝 줄 `108 more...`)` |
| A12 | `'from '` (2)                             | `''`              | list(192) | ['abc', 'annotationlib', 'antigravity', 'argparse', …] (192)         | +0   | `>>> from / [ not unique ] ; Tab2: 메뉴 22줄(끝 줄 `108 more...`)`   |
| A13 | `'from os import '` (1)                   | `''`              | list(1)   | ['path'] (1)                                                         | +4   | `>>> from os import path`                                            |
| A14 | `'import zzzz'` (1)                       | `'zzzz'`          | []        | []                                                                   | +0   | `>>> import zzzz`                                                    |
| A15 | `'import os.zzz'` (1)                     | `'os.zzz'`        | []        | []                                                                   | +0   | `>>> import os.zzz`                                                  |
| A16 | `'from . import x'` (1)                   | `'x'`             | []        | []                                                                   | +0   | `>>> from . import x`                                                |
| A17 | `'from .'` (1)                            | `'.'`             | []        | []                                                                   | +0   | `>>> from .`                                                         |
| A18 | `'from .a'` (1)                           | `'.a'`            | []        | []                                                                   | +0   | `>>> from .a`                                                        |
| A19 | `'from . import '` (1)                    | `''`              | []        | []                                                                   | +0   | `>>> from . import`                                                  |
| A20 | `'from math import s'` (1)                | `'s'`             | []        | []                                                                   | +0   | `>>> from math import s`                                             |
| A21 | `'from os import (path, s'` (1)           | `'s'`             | []        | []                                                                   | +0   | `>>> from os import (path, s`                                        |
| A22 | `'import os '` (1)                        | `''`              | None      | [' '] (1)                                                            | +2   | `>>> import os`                                                      |
| A23 | `'import os.path '` (1)                   | `''`              | None      | [' '] (1)                                                            | +1   | `>>> import os.path`                                                 |
| A24 | `'from os import path '` (1)              | `''`              | None      | [' '] (1)                                                            | +4   | `>>> from os import path`                                            |
| A25 | `'import os; os.pa'` (1)                  | `'os.pa'`         | None      | ['os.pardir', 'os.path', 'os.pathconf(', 'os.pathconf_names', …] (5) | +0   | `>>> import os; os.pa / [ not unique ]`                              |
| A26 | `'import os\nos.pa'` (1)                  | `'os.pa'`         | None      | ['os.pardir', 'os.path', 'os.pathconf(', 'os.pathconf_names', …] (5) | +0   | `... os.pa / [ not unique ]`                                         |
| A27 | `'x = 1'` (1)                             | `'1'`             | None      | []                                                                   | +0   | `>>> x = 1`                                                          |
| A28 | `'import os; import s'` (1)               | `'s'`             | list(27)  | ['sched', 'secrets', 'select', 'selectors', …] (27)                  | +0   | `>>> import os; import s / [ not unique ]`                           |
| A29 | `'x = 1; import o'` (1)                   | `'o'`             | list(4)   | ['opcode', 'operator', 'optparse', 'os'] (4)                         | +0   | `>>> x = 1; import o / [ not unique ]`                               |
| A30 | `'x = 1\nimport o'` (1)                   | `'o'`             | list(4)   | ['opcode', 'operator', 'optparse', 'os'] (4)                         | +0   | `... import o / [ not unique ]`                                      |
| A31 | `'if True:\n    import o'` (1)            | `'o'`             | list(4)   | ['opcode', 'operator', 'optparse', 'os'] (4)                         | +0   | `...     import o / [ not unique ]`                                  |
| A32 | `'from os import (\n    p'` (1)           | `'p'`             | list(1)   | ['path'] (1)                                                         | +3   | `...     path`                                                       |
| A33 | `'from os import (\n    path,\n    '` (1) | `''`              | list(1)   | ['path'] (1)                                                         | +4   | `...     path`                                                       |
| A34 | `'def f():\n    yield from o'` (1)        | `'o'`             | list(4)   | ['opcode', 'operator', 'optparse', 'os'] (4)                         | +0   | `...     yield from o / [ not unique ]`                              |
| A35 | `'def f():\n    yield from '` (1)         | `''`              | list(192) | ['abc', 'annotationlib', 'antigravity', 'argparse', …] (192)         | +0   | `...     yield from / [ not unique ]`                                |
| A36 | `'raise ValueError from o'` (1)           | `'o'`             | list(4)   | ['opcode', 'operator', 'optparse', 'os'] (4)                         | +0   | `>>> raise ValueError from o / [ not unique ]`                       |
| A37 | `'import os  # c\n'` (1)                  | `''`              | list(1)   | ['os'] (1)                                                           | +2   | `... os`                                                             |

관찰:

- `MC`가 `None`이고 스템이 비면 `res = [' ' * (4 - 열 % 4)]` 한 개(A22 2칸, A23 1칸, A24 4칸). `MC`가 `[]`이면 `res`도 `[]`이고 화면 무변화(A14~A21). 대조군 `x = 1`은 `MC` `None` -> rlcompleter `[]` -> 무변화(A27).
- 후보 1개면 즉시 삽입, 여러 개면 공통 접두사만 삽입하고 `[ not unique ]`, 두 번째 Tab이 열 우선 메뉴를 그린다(A11: 24행 화면에서 메뉴 단어 21줄 + `108 more...` 줄).
- `import `·`from `·`yield from ` 빈 스템은 192개(빈 cwd), `import o`·`from o`·`yield from o`·`raise ValueError from o`는 4개(`opcode`, `operator`, `optparse`, `os`).
- `ModuleCompleter` 입력은 `buffer[:pos]` 전체(다중 줄 포함)다. `x = 1\nimport o`(A30), `if True:\n    import o`(A31)가 모듈 완성이 된다.

### 측정 A 추가: 스템과 파싱이 어긋나는 입력 (`import_extra`)

| ID  | 입력 (Tab)                   | 스템  | MC        | res                                                          | 삽입 | Tab 뒤 화면                       |
| --- | ---------------------------- | ----- | --------- | ------------------------------------------------------------ | ---- | --------------------------------- |
| X01 | `'import os.pa  # c'` (1)    | `'c'` | list(1)   | ['os.path'] (1)                                              | +6   | `>>> import os.pa  # cs.path`     |
| X02 | `'import os.pa\n'` (1)       | `''`  | list(1)   | ['os.path'] (1)                                              | +7   | `... os.path`                     |
| X03 | `'import os, '` (1)          | `''`  | list(192) | ['abc', 'annotationlib', 'antigravity', 'argparse', …] (192) | +0   | `>>> import os, / [ not unique ]` |
| X04 | `'from os import path,'` (1) | `''`  | list(1)   | ['path'] (1)                                                 | +4   | `>>> from os import path,path`    |

## 5. 측정 B: 네이티브 3.14.4 대 pyodide 314.0.7 (95케이스)

결과 형식: `null` = `None`, `[]` = 무동작, 목록 = 후보(`native_vs_pyodide.json`의 `native`·`pyodide`, 종류는 `*_kind`). 입력 줄은 `lines_B.json`.

### 카운트

| 구분             | 케이스 | 동일 | 차이 | 환경 | zip stdlib | 기타 |
| ---------------- | ------ | ---- | ---- | ---- | ---------- | ---- |
| 전체             | 95     | 75   | 20   | 16   | 4          | 0    |
| A(측정 A 텍스트) | 37     | 29   | 8    | 6    | 2          | 0    |
| 추가 패턴        | 16     | 12   | 4    | 2    | 2          | 0    |
| 기대값 확인      | 6      | 6    | 0    | 0    | 0          | 0    |
| 보강             | 36     | 28   | 8    | 8    | 0          | 0    |

분류 규칙(`compare_native_pyodide.py` 상단): env = 차이 항목이 전부 환경 전용 최상위 모듈(또는 그 서브모듈), zip stdlib = 네이티브에만 있는 항목이 전부 `HARDCODED_SUBMODULES` 확장, 기타 = 나머지.
`None` 대 목록의 판정 자체가 다른 줄과 파서 결과가 다른 줄은 기타로 센다(해당 0줄). 순서만 다른 줄 0줄.

### 차이 20줄

| ID   | 입력                               | 분류       | 네이티브  | pyodide   | 네이티브 전용                                                                                     | pyodide 전용                                                                    |
| ---- | ---------------------------------- | ---------- | --------- | --------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| B007 | `'import os, sy'`                  | env        | list(4)   | list(3)   | syslog                                                                                            | -                                                                               |
| B008 | `'import os as o, sy'`             | env        | list(4)   | list(3)   | syslog                                                                                            | -                                                                               |
| B009 | `'import collections.a'`           | zip stdlib | list(1)   | []        | collections.abc                                                                                   | -                                                                               |
| B010 | `'from collections import a'`      | zip stdlib | list(1)   | []        | abc                                                                                               | -                                                                               |
| B011 | `'import '`                        | env        | list(192) | list(178) | curses, dbm, ensurepip, grp, idlelib, …(+10)                                                      | pyodide                                                                         |
| B012 | `'from '`                          | env        | list(192) | list(178) | curses, dbm, ensurepip, grp, idlelib, …(+10)                                                      | pyodide                                                                         |
| B028 | `'import os; import s'`            | env        | list(27)  | list(26)  | syslog                                                                                            | -                                                                               |
| B035 | `'def f():\n    yield from '`      | env        | list(192) | list(178) | curses, dbm, ensurepip, grp, idlelib, …(+10)                                                      | pyodide                                                                         |
| B038 | `'import _'`                       | env        | list(100) | list(90)  | _aix_support, _android_support, _apple_support, _curses, _curses_panel, …(+12)                    | _pyodide, _pyodide_core, _testbuffer, _testcapi, _testclinic, …(+2)             |
| B044 | `'from xml.parsers.expat import '` | zip stdlib | list(2)   | []        | errors, model                                                                                     | -                                                                               |
| B045 | `'import xml.parsers.expat.'`      | zip stdlib | list(2)   | []        | xml.parsers.expat.errors, xml.parsers.expat.model                                                 | -                                                                               |
| B050 | `'import  '`                       | env        | list(192) | list(178) | curses, dbm, ensurepip, grp, idlelib, …(+10)                                                      | pyodide                                                                         |
| B060 | `'import os,'`                     | env        | list(192) | list(178) | curses, dbm, ensurepip, grp, idlelib, …(+10)                                                      | pyodide                                                                         |
| B061 | `'import os, '`                    | env        | list(192) | list(178) | curses, dbm, ensurepip, grp, idlelib, …(+10)                                                      | pyodide                                                                         |
| B090 | `'import tkinter.'`                | env        | list(11)  | []        | tkinter.colorchooser, tkinter.commondialog, tkinter.constants, tkinter.dialog, tkinter.dnd, …(+6) | -                                                                               |
| B091 | `'import pyodide.'`                | env        | []        | list(6)   | -                                                                                                 | pyodide.code, pyodide.common, pyodide.console, pyodide.ffi, pyodide.http, …(+1) |
| B092 | `'import c'`                       | env        | list(20)  | list(19)  | curses                                                                                            | -                                                                               |
| B093 | `'import p'`                       | env        | list(21)  | list(19)  | pip, pwd, pydoc_data                                                                              | pyodide                                                                         |
| B094 | `'import t'`                       | env        | list(21)  | list(18)  | tkinter, turtle, turtledemo                                                                       | -                                                                               |
| B095 | `'import s'`                       | env        | list(27)  | list(26)  | syslog                                                                                            | -                                                                               |

### 환경 모듈 집합 차이 (`import ` + `import _` 줄에서 도출)

- 네이티브에만 있음(밑줄 없음, 15개): `curses`, `dbm`, `ensurepip`, `grp`, `idlelib`, `pip`, `pwd`, `pydoc_data`, `readline`, `resource`, `syslog`, `tkinter`, `turtle`, `turtledemo`, `venv`
- 네이티브에만 있음(밑줄, 17개): `_aix_support`, `_android_support`, `_apple_support`, `_curses`, `_curses_panel`, `_dbm`, `_hashlib`, `_interpchannels`, `_interpqueues`, `_interpreters`, `_ios_support`, `_multiprocessing`, `_osx_support`, `_posixshmem`, `_pydecimal`, `_tkinter`, `_uuid`
- pyodide에만 있음(8개): `_pyodide`, `_pyodide_core`, `_testbuffer`, `_testcapi`, `_testclinic`, `_testclinic_limited`, `_testlimitedcapi`, `pyodide`
- `import ` 후보 수: 네이티브 192, pyodide 178.

## 6. 측정 C: 게이트 건전성 코퍼스 (53줄)

게이트 = `/\b(import|from)\b/`(JS, 플래그 없음)가 입력 텍스트에 매치되는가. 입력은 `lines_C.json`, 판정은 네이티브 `ModuleCompleter().get_completions`(pyodide도 같은 결과).

| 분류                            | 네이티브 | pyodide |
| ------------------------------- | -------- | ------- |
| gate 거짓·None(건전)            | 25       | 25      |
| gate 거짓·비None(예외)          | 5        | 5       |
| gate 참·None(오탐)              | 17       | 17      |
| gate 참·비None(참 양성 또는 []) | 6        | 6       |

- 게이트 거짓인데 `None`이 아닌 예외 5줄(네이티브·pyodide 동일): `'1import os'`, `'1from os'`, `'1jimport os'`, `'1.5from os'`, `'0x1fimport os'`. 전부 숫자 리터럴 바로 뒤에 키워드가 붙은 입력이다. 3.14의 `tokenize`가
  `NUMBER` + `NAME('import')`로 토큰화해 `ImportParser`가 받아들인다(문법 오류 입력). 이 예외 5줄 외의 게이트 거짓 25줄은 전부 `None`이다.
- 게이트 참인데 `None`인 줄(오탐, 허용: 왕복만 늘어남) 17줄: `'x = "import os"'`, `'# from'`, `'# import os'`, `'"from a"'`, `"print('import')"`, `"x = 'from os import path'"`, `'foo.import'`, `'print(from'`, `'import'`, `'from'`, `'x = 1  # import'`, `'yield from'`, `'raise X from'`, `'이import os'`, `'import이 os'`, `'import os; os.pa'`, `'import os\nos.pa'`.
- JS `\b`와 파이썬 `re` `\b`가 다르게 판정한 줄(JS 참, 파이썬 거짓; 안전한 방향): `'이import os'`, `'import이 os'`.
- 네이티브 대 pyodide 판정 종류(None/[]/list)가 다른 줄: 0줄.

| ID  | 입력                          | 게이트(JS) | 네이티브                       | pyodide | 분류(네이티브)                  |
| --- | ----------------------------- | ---------- | ------------------------------ | ------- | ------------------------------- |
| C01 | `'x = 1'`                     | 거짓       | None                           | None    | gate 거짓·None(건전)            |
| C02 | `'os.pa'`                     | 거짓       | None                           | None    | gate 거짓·None(건전)            |
| C03 | `'print('`                    | 거짓       | None                           | None    | gate 거짓·None(건전)            |
| C04 | `"__import__('os')"`          | 거짓       | None                           | None    | gate 거짓·None(건전)            |
| C05 | `'important.x'`               | 거짓       | None                           | None    | gate 거짓·None(건전)            |
| C06 | `'imports.pa'`                | 거짓       | None                           | None    | gate 거짓·None(건전)            |
| C07 | `'reimport'`                  | 거짓       | None                           | None    | gate 거짓·None(건전)            |
| C08 | `''`                          | 거짓       | None                           | None    | gate 거짓·None(건전)            |
| C09 | `'   '`                       | 거짓       | None                           | None    | gate 거짓·None(건전)            |
| C10 | `'\t'`                        | 거짓       | None                           | None    | gate 거짓·None(건전)            |
| C11 | `'def f():'`                  | 거짓       | None                           | None    | gate 거짓·None(건전)            |
| C12 | `'    return x'`              | 거짓       | None                           | None    | gate 거짓·None(건전)            |
| C13 | `'fromage.x'`                 | 거짓       | None                           | None    | gate 거짓·None(건전)            |
| C14 | `'from_ = 1'`                 | 거짓       | None                           | None    | gate 거짓·None(건전)            |
| C15 | `'print(from_)'`              | 거짓       | None                           | None    | gate 거짓·None(건전)            |
| C16 | `'_import'`                   | 거짓       | None                           | None    | gate 거짓·None(건전)            |
| C17 | `'import_x'`                  | 거짓       | None                           | None    | gate 거짓·None(건전)            |
| C18 | `'x.imported'`                | 거짓       | None                           | None    | gate 거짓·None(건전)            |
| C19 | `'os.path.join(a, b)'`        | 거짓       | None                           | None    | gate 거짓·None(건전)            |
| C20 | `'for x in range(3):'`        | 거짓       | None                           | None    | gate 거짓·None(건전)            |
| C21 | `'x = [i for i in y]'`        | 거짓       | None                           | None    | gate 거짓·None(건전)            |
| C22 | `'x = 1\ny = 2'`              | 거짓       | None                           | None    | gate 거짓·None(건전)            |
| C23 | `'def f():\n    return'`      | 거짓       | None                           | None    | gate 거짓·None(건전)            |
| C24 | `'1import os'`                | 거짓       | list(1) ['os']                 | list(1) | gate 거짓·비None(예외)          |
| C25 | `'1from os'`                  | 거짓       | list(1) ['os']                 | list(1) | gate 거짓·비None(예외)          |
| C26 | `'1jimport os'`               | 거짓       | list(1) ['os']                 | list(1) | gate 거짓·비None(예외)          |
| C27 | `'1.5from os'`                | 거짓       | list(1) ['os']                 | list(1) | gate 거짓·비None(예외)          |
| C28 | `'0x1fimport os'`             | 거짓       | list(1) ['os']                 | list(1) | gate 거짓·비None(예외)          |
| C29 | `'ｉmport os'`                | 거짓       | None                           | None    | gate 거짓·None(건전)            |
| C30 | `'def f(from_=1): pass'`      | 거짓       | None                           | None    | gate 거짓·None(건전)            |
| C31 | `'x = "import os"'`           | 참         | None                           | None    | gate 참·None(오탐)              |
| C32 | `'# from'`                    | 참         | None                           | None    | gate 참·None(오탐)              |
| C33 | `'# import os'`               | 참         | None                           | None    | gate 참·None(오탐)              |
| C34 | `'"from a"'`                  | 참         | None                           | None    | gate 참·None(오탐)              |
| C35 | `"print('import')"`           | 참         | None                           | None    | gate 참·None(오탐)              |
| C36 | `"x = 'from os import path'"` | 참         | None                           | None    | gate 참·None(오탐)              |
| C37 | `'foo.import'`                | 참         | None                           | None    | gate 참·None(오탐)              |
| C38 | `'print(from'`                | 참         | None                           | None    | gate 참·None(오탐)              |
| C39 | `'import'`                    | 참         | None                           | None    | gate 참·None(오탐)              |
| C40 | `'from'`                      | 참         | None                           | None    | gate 참·None(오탐)              |
| C41 | `'x = 1  # import'`           | 참         | None                           | None    | gate 참·None(오탐)              |
| C42 | `'yield from'`                | 참         | None                           | None    | gate 참·None(오탐)              |
| C43 | `'raise X from'`              | 참         | None                           | None    | gate 참·None(오탐)              |
| C44 | `'이import os'`               | 참         | None                           | None    | gate 참·None(오탐)              |
| C45 | `'import이 os'`               | 참         | None                           | None    | gate 참·None(오탐)              |
| C46 | `'import os.pa'`              | 참         | list(1) ['os.path']            | list(1) | gate 참·비None(참 양성 또는 []) |
| C47 | `'from os import pa'`         | 참         | list(1) ['path']               | list(1) | gate 참·비None(참 양성 또는 []) |
| C48 | `'x = 1; import o'`           | 참         | list(4) ['opcode', 'operator'] | list(4) | gate 참·비None(참 양성 또는 []) |
| C49 | `'x = 1\nimport o'`           | 참         | list(4) ['opcode', 'operator'] | list(4) | gate 참·비None(참 양성 또는 []) |
| C50 | `'raise ValueError from o'`   | 참         | list(4) ['opcode', 'operator'] | list(4) | gate 참·비None(참 양성 또는 []) |
| C51 | `'import os  # c\n'`          | 참         | list(1) ['os']                 | list(1) | gate 참·비None(참 양성 또는 []) |
| C52 | `'import os; os.pa'`          | 참         | None                           | None    | gate 참·None(오탐)              |
| C53 | `'import os\nos.pa'`          | 참         | None                           | None    | gate 참·None(오탐)              |

## 7. 기대값 대조 (49항목, 일치 43, 불일치 6)

| 항목                                                                                     | 기대                                                         | 실측                                                         | 결과       | 비고                                                                 |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ | ---------- | -------------------------------------------------------------------- |
| `import ` 후보 수                                                                        | `192`                                                        | `192`                                                        | 일치       |                                                                      |
| `from ` 후보 수                                                                          | `192`                                                        | `192`                                                        | 일치       |                                                                      |
| `import os.p`                                                                            | `["os.path"]`                                                | `["os.path"]`                                                | 일치       |                                                                      |
| `from os.p`                                                                              | `["os.path"]`                                                | `["os.path"]`                                                | 일치       |                                                                      |
| `from os import p`                                                                       | `["path"]`                                                   | `["path"]`                                                   | 일치       |                                                                      |
| `from os import `                                                                        | `["path"]`                                                   | `["path"]`                                                   | 일치       |                                                                      |
| `from os import (`                                                                       | `["path"]`                                                   | `["path"]`                                                   | 일치       |                                                                      |
| `import xml.dom.` 후보 수                                                                | `7`                                                          | `7`                                                          | 일치       |                                                                      |
| `import os, sy` 스템(pty)                                                                | `"sy"`                                                       | `"sy"`                                                       | 일치       |                                                                      |
| `import os, sy` 후보 수                                                                  | `4`                                                          | `4`                                                          | 일치       |                                                                      |
| `import os as o, sy` 스템(pty)                                                           | `"sy"`                                                       | `"sy"`                                                       | 일치       |                                                                      |
| `import os as o, sy` 후보 수                                                             | `4`                                                          | `4`                                                          | 일치       |                                                                      |
| `from xml.dom import m`                                                                  | `["minicompat", "minidom"]`                                  | `["minicompat", "minidom"]`                                  | 일치       |                                                                      |
| `import os; os.pa`                                                                       | `null`                                                       | `null`                                                       | 일치       |                                                                      |
| `'import os; import s'` 정상 모듈 완성(비어 있지 않은 목록)                              | `true`                                                       | `true`                                                       | 일치       |                                                                      |
| `'x = 1; import o'` 정상 모듈 완성(비어 있지 않은 목록)                                  | `true`                                                       | `true`                                                       | 일치       |                                                                      |
| `'x = 1\nimport o'` 정상 모듈 완성(비어 있지 않은 목록)                                  | `true`                                                       | `true`                                                       | 일치       |                                                                      |
| `'if True:\n    import o'` 정상 모듈 완성(비어 있지 않은 목록)                           | `true`                                                       | `true`                                                       | 일치       |                                                                      |
| `'from os import (\n    p'` 정상 모듈 완성(비어 있지 않은 목록)                          | `true`                                                       | `true`                                                       | 일치       |                                                                      |
| `from os import (path, s` = []                                                           | `[]`                                                         | `[]`                                                         | 일치       |                                                                      |
| `import zzzz` = []                                                                       | `[]`                                                         | `[]`                                                         | 일치       |                                                                      |
| `import os.zzz` = []                                                                     | `[]`                                                         | `[]`                                                         | 일치       |                                                                      |
| `from . import x` = []                                                                   | `[]`                                                         | `[]`                                                         | 일치       |                                                                      |
| `from .a` = []                                                                           | `[]`                                                         | `[]`                                                         | 일치       |                                                                      |
| `from .. import ` = []                                                                   | `[]`                                                         | `[]`                                                         | 일치       |                                                                      |
| `from math import s` = []                                                                | `[]`                                                         | `[]`                                                         | 일치       |                                                                      |
| `from sys import ` = []                                                                  | `[]`                                                         | `[]`                                                         | 일치       |                                                                      |
| `import os ` = None                                                                      | `null`                                                       | `null`                                                       | 일치       |                                                                      |
| `import os as x` = None                                                                  | `null`                                                       | `null`                                                       | 일치       |                                                                      |
| `from os import path ` = None                                                            | `null`                                                       | `null`                                                       | 일치       |                                                                      |
| pty `import os ` -> 공백 2칸                                                             | `2`                                                          | `2`                                                          | 일치       |                                                                      |
| pty `import os.path ` -> 공백 1칸                                                        | `1`                                                          | `1`                                                          | 일치       |                                                                      |
| pty `from os import path ` -> 공백 4칸                                                   | `4`                                                          | `4`                                                          | 일치       |                                                                      |
| pty `from os import (\n    path,\n    ` 빈 스템 -> `path` 삽입                           | `"...     path"`                                             | `"...     path"`                                             | 일치       |                                                                      |
| pty `yield from o` 후보 수                                                               | `4`                                                          | `4`                                                          | 일치       |                                                                      |
| pty `yield from ` 후보 수                                                                | `192`                                                        | `192`                                                        | 일치       |                                                                      |
| pty `import os  # c\n` 다음 빈 줄 Tab -> `os` 삽입                                       | `"... os"`                                                   | `"... os"`                                                   | 일치       |                                                                      |
| 측정 B 케이스 수                                                                         | `65`                                                         | `95`                                                         | **불일치** | 기대는 65개 이상. 사전 조사 줄 목록이 저장되지 않아 줄 목록이 다르다 |
| 측정 B 동일 수                                                                           | `49`                                                         | `75`                                                         | **불일치** | 케이스 집합이 달라 직접 비교 불가                                    |
| 측정 B 차이 수                                                                           | `16`                                                         | `20`                                                         | **불일치** | 케이스 집합이 달라 직접 비교 불가                                    |
| 측정 B 차이 중 환경 모듈 집합                                                            | `14`                                                         | `16`                                                         | **불일치** | 케이스 집합이 달라 직접 비교 불가                                    |
| 측정 B 차이 중 zip stdlib                                                                | `2`                                                          | `4`                                                          | **불일치** | xml.parsers.expat 패턴 2줄이 추가로 걸림(같은 원인)                  |
| 네이티브 전용 최상위 모듈(밑줄 없는 것)                                                  | `["curses", "dbm", "ensurepip", "grp", "idlelib", "pip", "…` | `["curses", "dbm", "ensurepip", "grp", "idlelib", "pip", "…` | 일치       |                                                                      |
| 네이티브 전용 최상위 모듈(밑줄 있는 것)                                                  | `[]`                                                         | `["_aix_support", "_android_support", "_apple_support", "_…` | **불일치** | 기대 목록에 없던 17개가 `import _`에서 나온다                        |
| pyodide 전용 최상위 모듈                                                                 | `["_pyodide", "_pyodide_core", "_testbuffer", "_testcapi",…` | `["_pyodide", "_pyodide_core", "_testbuffer", "_testcapi",…` | 일치       |                                                                      |
| pyodide `import collections.a` = []                                                      | `[]`                                                         | `[]`                                                         | 일치       |                                                                      |
| pyodide `from collections import a` = []                                                 | `[]`                                                         | `[]`                                                         | 일치       |                                                                      |
| pty 훅 mc == 네이티브 직접 호출(A 37줄 + 추가 4줄 중 불일치 수)                          | `0`                                                          | `0`                                                          | 일치       |                                                                      |
| ModuleCompleter() 대 make_default_module_completer() 결과 차이 줄 수(B 네이티브·pyodide) | `0`                                                          | `0`                                                          | 일치       |                                                                      |

측정 B 카운트 5항목이 불일치인 이유: 사전 조사의 65케이스 줄 목록이 저장되지 않았다. DELTA 명시 줄만(A 텍스트 37 + 추가 패턴 16 + 기대값 확인 6 = 59줄)
보면 차이 12줄(환경 8, zip 4)이다.
환경 차이 14줄이라는 기대는 이 줄들만으로는 나오지 않는다(사전 조사에 알파벳별 접두사 줄 등 다른 줄이 있었던 것으로 추정하나 확인 불가). 환경 모듈 이름 집합(밑줄 없는 15개, pyodide 전용 8개)은 정확히 재현됐다.

## 8. 파일 목록 (이 폴더)

| 파일                                                                                                                                                                                                                                                                    | 내용                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `res_import.json`                                                                                                                                                                                                                                                       | 측정 A 결과(37케이스, 텍스트 키). 케이스마다 typed·steps[화면·커서·훅 기록]             |
| `res_import_extra.json`                                                                                                                                                                                                                                                 | 측정 A 추가 4케이스(스템 불일치)                                                        |
| `native_vs_pyodide.json`                                                                                                                                                                                                                                                | 측정 B 결과(95줄, 줄 텍스트 키). native·pyodide·parse·same·diff(분류)                   |
| `native_vs_pyodide.meta.json`                                                                                                                                                                                                                                           | B 요약: 카운트, 출처별 카운트, 환경 모듈 집합, 인터프리터·`sys.path`·`sys.modules` 변화 |
| `gate_corpus.json` / `.meta.json`                                                                                                                                                                                                                                       | 측정 C 결과(53줄)와 요약(예외·오탐 목록)                                                |
| `expectations_check.json`                                                                                                                                                                                                                                               | 기대값 49항목 대조                                                                      |
| `pyodide_zip_patch_check.json`                                                                                                                                                                                                                                          | 참고: `_is_stdlib_module` 오버라이드 진단                                               |
| `cases_import.json`, `lines_B.json`, `lines_C.json`                                                                                                                                                                                                                     | 입력 케이스(A 그룹 `import`·`import_extra`, B 줄, C 줄)                                 |
| `native_result*.json`, `pyodide_result*.json`, `gate_js_C.json`                                                                                                                                                                                                         | B·C 원시 프로브 출력                                                                    |
| `runcases_import.py`, `make_lines_B.py`, `make_lines_C.py`, `mc_probe.py`, `native_complete.py`, `pyodide_complete.mjs`, `gate_js.mjs`, `compare_native_pyodide.py`, `build_gate_corpus.py`, `verify_expectations.py`, `pyodide_zip_patch_check.mjs`, `make_summary.py` | 측정·조립 스크립트                                                                      |
| `ptyrepl.py`, `common.py`, `hook_startup.py`, `pylib/`                                                                                                                                                                                                                  | 원본 하니스 복사본(수정점은 3절)과 `pyte`·`wcwidth` 사본                                |
