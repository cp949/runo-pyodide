# pty 캡처 도구

CPython 3.14 REPL을 pty로 구동해 기준 데이터(`../rd-015`·`../rd-016`)를 만드는 스크립트 모음이다. 실행 전제·설치는
`../README.md`, 파일별 명령 표·소요 시간·허용 차이는 `../REGEN.md`에 있다. 이 문서는 도구별 입력·출력과 인자 규칙만 다룬다.

## 도구와 입출력

`--dir`은 작업 폴더(고정 파일명으로 읽고 쓴다)다. 기준 데이터 폴더(`../rd-015`·`../rd-016`)를 `--dir`·`--out`에 주지 않는다.
"pyte 필요"는 그 스크립트를 돌리는 파이썬에 `requirements.txt`의 패키지가 있어야 한다는 뜻이다(하니스 venv).

| 파일                          | 실행                        | pyte 필요                    | 입력                                                                           | 출력                                                                 |
| ----------------------------- | --------------------------- | ---------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `ptyrepl.py`                  | python                      | 예                           | (라이브러리. 직접 실행하면 셀프테스트)                                         | `Session`(pty·pyte), 인터프리터 해석·게이트                          |
| `common.py`                   | python                      | 예                           | (라이브러리)                                                                   | `fresh()`(훅 포함 새 세션), `--out`·`--with-mc` 인자 헬퍼            |
| `hook_startup.py`             | 자식 REPL의 `PYTHONSTARTUP` | 아니오                       | 환경변수 `COMPLOG`·`PTY_HOOK_MC`                                               | `COMPLOG` 파일에 `get_completions` 호출 기록                         |
| `mc_probe.py`                 | 네이티브·pyodide 양쪽       | 아니오                       | (프로브 소스)                                                                  | `probe(lines_json)`                                                  |
| `runcases.py`                 | python                      | 예                           | `../rd-015/cases.json`                                                         | `res_<그룹>_<lo>.json` 또는 SPEC의 `=파일명`                         |
| `runcases_import.py`          | python                      | 예                           | `../rd-016/cases_import.json`                                                  | `res_import.json`·`res_import_extra.json`                            |
| `make_lines_B.py`             | python                      | 아니오                       | `cases_import.json`                                                            | `lines_B.json`                                                       |
| `make_lines_C.py`             | python                      | 아니오                       | (코드 안의 코퍼스)                                                             | `lines_C.json`                                                       |
| `native_complete.py`          | python                      | 아니오(대상은 자식으로 실행) | `lines_B.json` 또는 `lines_C.json`                                             | `native_result.json`·`native_result_C.json`(위치 인자로 이름 지정)   |
| `pyodide_complete.mjs`        | node                        | -                            | `lines_B.json` 또는 `lines_C.json`                                             | `pyodide_result.json`·`pyodide_result_C.json`(위치 인자로 이름 지정) |
| `gate_js.mjs`                 | node                        | -                            | `lines_C.json`                                                                 | `gate_js_C.json`(pyodide 로드 없음)                                  |
| `compare_native_pyodide.py`   | python                      | 아니오                       | `lines_B.json`·`native_result.json`·`pyodide_result.json`                      | `native_vs_pyodide.json`·`native_vs_pyodide.meta.json`               |
| `build_gate_corpus.py`        | python                      | 아니오                       | `lines_C.json`·`gate_js_C.json`·`native_result_C.json`·`pyodide_result_C.json` | `gate_corpus.json`·`gate_corpus.meta.json`                           |
| `compare_baseline.py`         | python                      | 아니오(표준 라이브러리만)    | 기준 폴더·재생성 폴더                                                          | 종료 코드, 차이 표, `--json`                                         |
| `pyodide_zip_patch_check.mjs` | node                        | -                            | `lines_B.json`·`native_result.json`·`pyodide_result.json`                      | `pyodide_zip_patch_check.json`(보조 진단)                            |
| `verify_expectations.py`      | python                      | 아니오                       | `res_import*.json`·`native_vs_pyodide*.json`                                   | `expectations_check.json`(보조 진단)                                 |
| `make_summary.py`             | python                      | 아니오                       | 위 산출물 전부                                                                 | `SUMMARY-import.md`(서술 산출물)                                     |
| `resolve_pyodide.mjs`         | node 모듈                   | -                            | -                                                                              | pyodide 경로·버전 해석(아래)                                         |
| `requirements.txt`            | -                           | -                            | -                                                                              | `pyte==0.8.2`·`wcwidth==0.8.4`                                       |

`pyodide_zip_patch_check.mjs`·`verify_expectations.py`·`make_summary.py`는 기준 대조 대상이 아니다. 실행되어 산출물이 나오는
것까지만 본다.

### 의존 관계(rd-016)

```text
cases_import.json ─┬─ runcases_import.py ───────────────► res_import.json, res_import_extra.json   (pty)
                   └─ make_lines_B.py ─► lines_B.json ─┬─ native_complete.py ────┐
                                                       └─ pyodide_complete.mjs ──┴─► compare_native_pyodide.py
                                                                                     ─► native_vs_pyodide.json(+.meta.json)
make_lines_C.py ─► lines_C.json ─┬─ native_complete.py ───┐
                                 ├─ pyodide_complete.mjs ─┼─► build_gate_corpus.py ─► gate_corpus.json(+.meta.json)
                                 └─ gate_js.mjs ──────────┘
```

### 의존 관계(rd-015)

```text
../rd-015/cases.json ─ runcases.py <SPEC>... ─► res_s1.json, res_s2_0.json, res_s7_{0,11,22}.json, res_s10_{0,13}.json   (pty)
```

### 비교

```text
기준 폴더(../rd-015 또는 ../rd-016) ┐
                                    ├─ compare_baseline.py ─► 종료 코드 0|1|2, 차이 표, (--json)
재생성 폴더(<OUT>)                  ┘
```

## 인자 규칙

| 인자                       | 받는 도구                                                                                                                         | 규칙                                                                                                                                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--python <경로>`          | `ptyrepl.py`·`runcases.py`·`runcases_import.py`·`native_complete.py`                                                              | 대상 인터프리터(자식 REPL·프로브를 띄울 파이썬). 하니스를 돌리는 파이썬이 아니다.                                                                                                           |
| `PTY_PYTHON`               | 위와 같음                                                                                                                         | `--python`이 없을 때 쓰는 환경변수.                                                                                                                                                         |
| `PATH`의 `python3.14`      | 위와 같음                                                                                                                         | 둘 다 없을 때 `shutil.which("python3.14")`. 홈 절대경로 기본값은 없다.                                                                                                                      |
| `--allow-version-mismatch` | 위와 같음                                                                                                                         | 대상 `sys.version_info[:3]`이 `3.14.4`가 아니어도 경고(`경고: 버전 불일치(...)`)만 하고 진행. 없으면 종료 코드 2로 중단.                                                                    |
| `--check-only`             | `ptyrepl.py`만                                                                                                                    | 해석·게이트만 하고 pty를 띄우지 않는다(종료 코드 0 또는 2).                                                                                                                                 |
| `--dir <폴더>`             | `runcases*.py`·`make_*`·`compare_native_pyodide.py`·`build_gate_corpus.py`·`verify_expectations.py`·`pyodide_zip_patch_check.mjs` | 작업 폴더. 기본값이 없다(기준 데이터 폴더를 실수로 덮어쓰지 않으려고). 폴더는 `runcases*.py`·`make_lines_B.py`·`make_lines_C.py`가 없으면 만들고, 나머지 `--dir` 도구는 폴더가 있어야 한다. |
| `--out <경로>`             | `runcases.py`·`runcases_import.py`                                                                                                | 결과 JSON 경로를 직접 지정. `runcases.py`는 SPEC이 하나일 때만, `runcases_import.py`는 그룹이 하나일 때만.                                                                                  |
| `--with-mc`                | `runcases.py`                                                                                                                     | 훅이 log 항목에 `mc`(ModuleCompleter 원시 결과)를 기록한다. **rd-015 기준에는 없으므로 기본 꺼짐.**                                                                                         |
| `--no-mc`                  | `runcases_import.py`                                                                                                              | `mc` 기록을 끈다. **rd-016 기준에는 있으므로 기본 켜짐**(`--with-mc`는 이 도구에 없다).                                                                                                     |
| `--cases <json>`           | `runcases*.py`·`make_lines_B.py`                                                                                                  | 케이스 정의. 기본값은 `../rd-015/cases.json`·`../rd-016/cases_import.json`(읽기 전용).                                                                                                      |
| `--pyodide <폴더>`         | `pyodide_complete.mjs`·`pyodide_zip_patch_check.mjs`                                                                              | pyodide 패키지 폴더(`pyodide.mjs`·`package.json`이 있는 곳).                                                                                                                                |

- `runcases.py`의 SPEC은 `그룹[:lo[:hi]][=출력파일명]`이다. 기본 출력명은 `res_<그룹>_<lo>.json`(hi는 이름에 넣지 않는다)이고,
  SPEC을 여러 개 주면 한 프로세스에서 순서대로 돈다(케이스마다 새 pty 세션). 예: `s7:11:22`는 그룹 `s7`의 `[11:22)` → `res_s7_11.json`.
- `runcases_import.py`는 그룹을 여러 개 받는다(`import import_extra`). `--lo`·`--hi`는 그룹이 하나일 때만 쓴다.
- 인터프리터 인자를 받는 도구는 시작 시 대상을 `-I -c`로 한 번 띄워 검사한다: (1) 버전 게이트, (2) 대상이 venv면 중단,
  (3) 대상에서 `pyte`·`wcwidth`가 import되면 중단. (2)·(3)은 `--allow-version-mismatch`로도 우회되지 않는다(자식 REPL의 모듈 후보
  집합이 바뀌기 때문이다, TRAP-27). 설치 위치는 `../README.md`.
- 하니스는 venv를 활성화하지 않고 `<venv>/bin/python`을 절대경로로 호출한다. 활성화하면 `PATH`의 `python3.14`가 venv의 것이 되어 (2)에 걸린다.
- 상대경로 `..`가 섞인 경로로 venv 파이썬을 호출하면 `Unexpected value in sys.prefix` 경고가 난다(동작은 정상). 절대경로를 쓴다.
- `PYTHONDONTWRITEBYTECODE=1`을 두고 실행하면 `tools/__pycache__`가 생기지 않는다(`.gitignore`에 없다).

### 자식 REPL 환경

`ptyrepl.Session`이 자식에게 넘기는 환경은 아래뿐이다: `TERM=xterm`, `PATH`, `HOME`(임시 폴더), `PYTHON_HISTORY`(임시 파일),
`PYTHON_COLORS=0`, `NO_COLOR=1`, `LANG=C.UTF-8`, 그리고 `fresh()`가 더하는 `COMPLOG`·`PYTHONSTARTUP`(`hook_startup.py`)·
(`--with-mc`일 때) `PTY_HOOK_MC=1`. `VIRTUAL_ENV`·`PYTHONPATH`는 넘기지 않는다. 창은 24×80, cwd는 빈 임시 폴더다.
케이스마다 새 세션을 띄우고 `SETUP` 5줄을 실행한 뒤 Ctrl+L을 보낸다. 화살표는 `TERM=xterm` 기준 `\x1bOA`(↑)·`\x1bOB`(↓)다(TRAP-18).

## pyodide 해석(node 도구)

`pyodide_complete.mjs`·`pyodide_zip_patch_check.mjs`는 `resolve_pyodide.mjs`로 pyodide 패키지 폴더를 찾는다. 순서:

1. `--pyodide <폴더>`(`pyodide.mjs`가 없으면 오류)
2. `createRequire(import.meta.url).resolve('pyodide/package.json')` — `tools/` 기준 일반 해석. `apps/demo`는 pyodide 의존이 없어 이
   저장소에서는 보통 실패한다(`check-dist`·`smoke:pack` 표면을 건드리지 않으려고 의존을 더하지 않았다).
3. 워크스페이스 폴백: `pnpm-workspace.yaml`이 있는 조상 폴더의 `packages/{pyodide-core,pyodide-repl,pyodide-dom-bridge}/node_modules/pyodide`

셋 다 없으면 종료 코드 2다(`pnpm install`을 먼저 실행한다). 실제 실행 로그의 첫 줄에 어느 규칙으로 찾았는지가 남는다:
`pyodide 패키지(workspace:packages/pyodide-core): <경로> (package.json version 314.0.7)`.

`pyodide/package.json`의 `version`은 다음 위치에 기록된다.

| 위치                                          | 키                       | 저장소 기준 데이터에 있는가 |
| --------------------------------------------- | ------------------------ | --------------------------- |
| `pyodide_result.json`·`pyodide_result_C.json` | 최상위 `pyodide_version` | 없음(중간 산출물)           |
| `native_vs_pyodide.meta.json`                 | `pyodide.version`        | 있음(기준값 `314.0.7`)      |
| 실행 로그 첫 줄                               | `package.json version`   | 없음                        |

런타임 `pyodide.version`이 `package.json`의 `version`과 다르면 `경고: 런타임 pyodide.version(...) != package.json version(...)`를 낸다.
`gate_corpus.meta.json`에는 pyodide 버전 필드가 없다. 새 버전으로 재측정할 때는 위 로그 첫 줄을 함께 보관한다.

## `compare_baseline.py`

```bash
<venv 또는 임의 python3>/bin/python apps/demo/e2e/pty/tools/compare_baseline.py <기준 폴더> <재생성 폴더> \
  [--files 기준이름[=재생성이름] ...] [--ignore-baseline-candidates 기준파일명=이름,이름,...] [--json <경로>] [--max-rows N]
```

표준 라이브러리만 쓰므로 어느 파이썬으로도 돈다.

| 종료 코드 | 뜻                                                              |
| --------- | --------------------------------------------------------------- |
| `0`       | 판정값 차이 0(환경 유래 차이는 있어도 된다. 표에 기록만 한다)   |
| `1`       | 판정값 차이 있음. 고치려 하지 말고 차이 표를 사용자에게 올린다. |
| `2`       | 실행 오류(폴더·파일 없음, JSON 파싱 실패, 인자 오류)            |

- 출력은 파일별 한 줄 요약과 차이 상세 표(파일·JSON 포인터·기준값·재생성값)다. `--json`은 같은 내용을 기계 판독 형태로 쓴다.
- 기본 대상은 rd-016 6파일(`res_import.json`·`res_import_extra.json`·`gate_corpus.json`·`gate_corpus.meta.json`·
  `native_vs_pyodide.json`·`native_vs_pyodide.meta.json`)이다. rd-015는 `--files`로 7파일을 나열한다.
  `--files 기준이름=재생성이름`은 파일명이 다른 짝을 내용으로 비교한다.
- 본문 JSON은 파싱한 값을 비교한다(키 순서·들여쓰기 무시, 배열 순서는 유지, bool과 int 구분). 본문의 모든 차이가 판정값 차이다.
- `*.meta.json`은 화이트리스트(`cases`·`counts*`·`*_differs*`·`sys_modules_*`·`gate_false_non_none_*`·`gate_true_none_*`)만 판정값으로
  비교한다. 나머지 필드(`cwd`·`stdlib_path`·`sys_path`·`python` 빌드 문자열·`version`·`pyodide_version`·`note`·`gate_regex_js`·시간 필드)는
  값이 달라도 "환경 유래 차이" 표에만 기록한다. `env_*_top_level`(환경 전용 최상위 모듈 집합)도 환경 유래로 기록한다(TRAP-27).
  단 분류 결과가 바뀌면 `counts`와 본문에서 판정값 차이로 따로 잡힌다.
- `--ignore-baseline-candidates 기준파일명=이름,이름,...`(반복 가능): 그 기준 파일의 `res` 배열에서만 지정한 이름을 뺀 뒤 재생성과
  엄격 비교한다. 재생성에 있는 이름은 빼지 않으므로 차이로 남고, 기준 어디에서도 빼지 못한 이름은 판정값 차이다. `res`를 뺀 케이스의
  `screen*` 차이는 열 폭(가장 긴 후보 이름)이 바뀐 열 배치 차이라 환경 유래 표로 옮긴다. 옮기는 조건: 양쪽 화면의 단어가 각 쪽 `res`의
  원소일 때만. 옵션 사용 사실은 출력과 `--json`의 `ignored_baseline_candidates`(`names`·`removed_counts`·`cases`·`unused`·
  `screen_diffs_moved_to_env`)에 남는다. 사용처와 위험은 `../REGEN.md`.
