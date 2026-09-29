# pty 측정 자료와 캡처 도구

CPython 3.14 REPL을 pty로 띄우고 pyte로 화면을 읽어 얻은 기준 데이터(`rd-*`)와, 그 데이터를 다시 만드는 도구(`tools/`)를 둔다.
웹 REPL의 동등성 판정(Tab 완성·취소·type-ahead 등)이 이 데이터를 리터럴 출처로 쓴다.

읽는 순서: **이 문서**(폴더·전제·설치) → [`REGEN.md`](./REGEN.md)(파일 ← 명령 표·소요 시간·허용 차이·재측정 순서) →
[`tools/README.md`](./tools/README.md)(도구별 입력·출력·인자 규칙·`compare_baseline.py`).

재측정(3.15 등)을 할지는 사용자가 정한다(ADR-0007). 이 문서는 도구를 쓰는 방법만 적는다.

## 폴더

| 경로       | 내용                                                                           | 다시 만드는 방법                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `rd-015/`  | Tab 완성(이름·속성) 기준 7파일 `res_s*.json` + 케이스 정의 `cases.json`        | `tools/runcases.py` (`REGEN.md`)                                                                                                   |
| `rd-016/`  | `import`/`from` 모듈 완성 기준 6파일 + `cases_import.json`·`SUMMARY-import.md` | `tools/` 파이프라인 (`REGEN.md`)                                                                                                   |
| `rd-008/`  | 취소 화면 측정(`pty_cancel.py`, `raw.txt`, `results.md`)                       | 자립형 스크립트. `tools/`를 쓰지 않고 결과는 사람 판정이라 재생성 대조가 없다                                                      |
| `rd-019/`  | type-ahead 측정(`pty_type_ahead.py`, `raw.txt`, `results.md`)                  | 위와 같음                                                                                                                          |
| `rd-048/`  | 빈 입력줄 Ctrl+D(EOF) 측정(`pty_ctrl_d.py`, `raw.txt`, `results.md`)           | 자립형 스크립트지만 `tools/ptyrepl.py`의 `Session`을 라이브러리로 쓴다(`--python`·`PTY_PYTHON`·버전 게이트는 `tools/`와 같은 규칙) |
| `tools/`   | 캡처·비교 도구                                                                 | [`tools/README.md`](./tools/README.md)                                                                                             |
| `REGEN.md` | 재생성 명령 표·소요 시간·허용 차이                                             | -                                                                                                                                  |

`rd-008`·`rd-019` 스크립트는 인터프리터를 `PY314` 환경변수(기본값 홈 절대경로)로 받는다. `tools/`의 `--python`·`PTY_PYTHON`·버전 게이트와
다른 규칙이다. `rd-048`은 `tools/ptyrepl.py`를 라이브러리로 써서 `tools/`와 같은 해석 순서·게이트를 쓴다.

**`rd-015/**`·`rd-016/**`의 데이터 파일은 읽기 전용이다.** 재생성물은 저장소 밖 임시 폴더 등 이 트리 밖에 쓴다.
`--dir`·`--out`에 이 폴더들을 주지 않는다. 기준 데이터를 새 측정으로 바꾸는 것은 재측정 결정이며 별도 작업이다.

## 실행 전제

| 항목            | 값                                                                                                                                  | 이유                                                                                                                                |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 대상 인터프리터 | CPython **3.14.4**. 해석 순서 `--python <경로>` > 환경변수 `PTY_PYTHON` > `PATH`의 `python3.14`                                     | 기준 데이터가 3.14.4 REPL(`_pyrepl`) 출력이다. 홈 절대경로 기본값은 없다.                                                           |
| 버전 게이트     | 대상의 `sys.version_info[:3]`이 `3.14.4`가 아니면 종료 코드 2로 중단. `--allow-version-mismatch`일 때만 경고 후 진행                | 다른 버전의 결과가 기준 대조에 섞이는 것을 막는다. 다른 버전 결과는 기준과 같다고 볼 수 없다.                                       |
| 대상 환경       | 대상은 venv가 아니고 `pyte`·`wcwidth`가 import되지 않아야 한다. 어긴 대상은 중단하며 우회 옵션이 없다                               | 자식 REPL의 `sys.path`가 바뀌면 모듈 후보 집합이 달라진다(TRAP-27).                                                                 |
| 하니스 패키지   | `pyte==0.8.2`, `wcwidth==0.8.4`(`tools/requirements.txt`). **하니스를 돌리는 venv에만** 설치한다                                    | pyte는 LGPLv3라 저장소에 벤더링하지 않는다. wcwidth는 MIT다.                                                                        |
| pty 크기·`TERM` | 24행 × 80열, `TERM=xterm`                                                                                                           | 기준 데이터 조건.                                                                                                                   |
| 화살표 바이트   | ↑ `\x1bOA`, ↓ `\x1bOB` (`TERM=xterm` 기준)                                                                                          | `TERM`과 어긋난 시퀀스는 오류 없이 버려져 "↑ 무동작"으로 오인된다(TRAP-18).                                                         |
| 색·기록         | `PYTHON_COLORS=0`, `NO_COLOR=1`, `PYTHON_HISTORY`는 임시 파일로 고정, `HOME`은 임시 폴더                                            | 색 이스케이프가 화면 비교를 오염시키고, 기록 파일이 홈을 오염시킨다.                                                                |
| 자식 REPL cwd   | **빈 임시 폴더**(하니스가 만든다)                                                                                                   | `sys.path[0] == ''`라 cwd의 `.py` 파일이 모듈 후보가 된다. 하니스 폴더에서 돌리면 `import ` 후보가 192 → 196개가 된다(TRAP-27).     |
| node 도구       | node(실측 v24.20.0)와 `pnpm install`이 끝난 워크스페이스. pyodide는 `--pyodide` > `createRequire` > 워크스페이스 폴백 순으로 찾는다 | 이 저장소의 pyodide는 pnpm catalog 의존이고 `apps/demo`에는 의존이 없다. 결과 JSON에 `pyodide_version`이 남는다(`tools/README.md`). |

## 설치

임의 경로에 하니스용 venv를 만들고 `pyte`·`wcwidth`를 설치한다. 대상 `python3.14`에는 설치하지 않는다.

```bash
# 저장소 루트에서
python3.14 -m venv /임의/경로/pty-venv
/임의/경로/pty-venv/bin/pip install -r apps/demo/e2e/pty/tools/requirements.txt
```

- 하니스(`tools/*.py`)는 **`/임의/경로/pty-venv/bin/python`을 절대경로로** 호출한다. venv를 activate하지 않는다(activate하면 `PATH`의
  `python3.14`가 venv의 것이 되어 대상 게이트가 중단한다).
- 대상은 venv 밖 원본 `python3.14`다. `--python "$(command -v python3.14)"`로 넘기거나 `PTY_PYTHON`을 설정한다.
- `PYTHONDONTWRITEBYTECODE=1`을 두고 실행한다(`tools/__pycache__`가 생기지 않는다).
- 상대경로 `..`가 섞인 경로로 venv 파이썬을 호출하면 `Unexpected value in sys.prefix` 경고가 난다(동작은 정상).

### 설치 확인(pty를 띄우지 않는다)

```bash
/임의/경로/pty-venv/bin/python apps/demo/e2e/pty/tools/ptyrepl.py --check-only --python "$(command -v python3.14)"
```

출력 예: `인터프리터(--python): <경로>` / `버전: 3.14.4 (...) (기대 3.14.4, 불일치=False)`, 종료 코드 0. 버전이 다르면
`기대 3.14.4, 실제 X.Y.Z`와 함께 종료 코드 2다. `--check-only` 없이 실행하면 pty를 실제로 띄우는 셀프테스트(약 6초, `os.getc` + Tab →
`os.getcwd` 확인)를 돈다.

## 다음

- 재생성 명령 전체와 소요 시간: [`REGEN.md`](./REGEN.md)
- 도구별 입출력·인자·비교기: [`tools/README.md`](./tools/README.md)
- 설계 문서의 요약: `docs/design/09-testing.md` 9.6.6, 재측정 절차 `docs/design/13-version-upgrade.md` 13.4
