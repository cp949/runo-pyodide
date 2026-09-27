# 기준 데이터 재생성

`rd-015/`(7파일)·`rd-016/`(6파일) 기준 데이터를 `tools/`로 다시 만드는 명령, 실측 소요 시간, 허용 차이를 적는다. 실행 전제·설치는
[`README.md`](./README.md), 도구별 입출력·인자는 [`tools/README.md`](./tools/README.md).

결과(2026-09-26, 인터프리터 CPython 3.14.4 `Clang 22.1.3`, pyodide 314.0.7, 각 파이프라인 2회 실행): **rd-016 6파일은 판정값 차이 0이고 5파일이
기준과 바이트 동일**, **rd-015 7파일 중 6파일이 바이트 동일이며 `res_s1.json`은 기준 후보 14개 이름을 제외한 뒤 판정값 차이 0**이다(아래
"허용 차이"). 같은 도구로 2회 연속 재생성한 결과는 두 파이프라인 모두 자기 대조에서 판정값 차이 0이다.

## 변수

아래 명령은 저장소 루트에서 실행한다.

```bash
TOOLS=apps/demo/e2e/pty/tools
VPY=/임의/경로/pty-venv/bin/python   # pyte==0.8.2·wcwidth==0.8.4가 설치된 하니스 venv. activate하지 않는다
P="$(command -v python3.14)"        # 대상 인터프리터. venv 밖 원본 3.14.4
export PYTHONDONTWRITEBYTECODE=1
```

`O`는 **저장소 `rd-015|016/` 밖의 출력 폴더**다(읽기 전용 규칙, `README.md`). `VPY`를 만드는 법은 `README.md` "설치".
`$VPY`는 하니스 venv의 python이다. `pyte`가 실제로 필요한 것은 `runcases.py`·`runcases_import.py`뿐이고(`tools/README.md` 표), 나머지 python 스크립트는 어느 python으로도 돈다. 아래 명령은 실측에 쓴 그대로 `$VPY`로 적었다.

## 파일 ← 명령

### rd-016 (6파일)

`--with-mc`: `runcases_import.py`는 **기본 켜짐**(`mc` 필드가 rd-016 기준에 있다. 끄는 인자는 `--no-mc`이고 `--with-mc`는 없다).
`mc`는 ModuleCompleter 원시 결과(`None`·`[]`·후보 목록)로 판정값이다. 비교에서 빼지 않는다.

| 기준 파일                     | 명령(아래 "rd-016 명령"의 단계)                                                                           | `--with-mc` | 실행 방식                        |
| ----------------------------- | --------------------------------------------------------------------------------------------------------- | ----------- | -------------------------------- |
| `res_import.json`             | `runcases_import.py import import_extra --dir "$O" --python "$P"` (A)                                     | 켜짐(기본)  | pty, 그룹 `import` 37케이스      |
| `res_import_extra.json`       | 같은 명령(A)                                                                                              | 켜짐(기본)  | pty, 그룹 `import_extra` 4케이스 |
| `native_vs_pyodide.json`      | B: `make_lines_B.py` → `native_complete.py`·`pyodide_complete.mjs` → `compare_native_pyodide.py`          | 해당 없음   | 프로브(pty 아님), 95줄           |
| `native_vs_pyodide.meta.json` | 같은 명령(B)                                                                                              | 해당 없음   | 위와 같음                        |
| `gate_corpus.json`            | C: `make_lines_C.py` → `native_complete.py`·`pyodide_complete.mjs`·`gate_js.mjs` → `build_gate_corpus.py` | 해당 없음   | 프로브(pty 아님), 53줄           |
| `gate_corpus.meta.json`       | 같은 명령(C)                                                                                              | 해당 없음   | 위와 같음                        |

같은 폴더의 `cases_import.json`은 입력(재생성 대상이 아니다), `SUMMARY-import.md`는 `make_summary.py`가 만드는 서술 산출물이다(대조 대상 아님. 서술
절은 이 저장소 도구 기준으로 다시 썼으므로 기준 파일과 문장이 같지 않다).

### rd-015 (7파일)

`--with-mc`: **꺼짐**(기본. rd-015 기준의 `log` 항목은 `{stem, buf, pos, res}`이고 `mc`가 없다). 켜면 항목에 `mc`가 더해져 기준과 어긋난다.

7파일은 명령 하나로 만든다. SPEC은 `그룹[:lo[:hi]][=출력파일명]`이다.

| 기준 파일         | SPEC             | 케이스              | `--with-mc` |
| ----------------- | ---------------- | ------------------- | ----------- |
| `res_s1.json`     | `s1=res_s1.json` | 그룹 s1 `[0:10)` 10 | 꺼짐        |
| `res_s2_0.json`   | `s2`             | s2 `[0:2)` 2        | 꺼짐        |
| `res_s7_0.json`   | `s7:0:11`        | s7 `[0:11)` 11      | 꺼짐        |
| `res_s7_11.json`  | `s7:11:22`       | s7 `[11:22)` 11     | 꺼짐        |
| `res_s7_22.json`  | `s7:22`          | s7 `[22:32)` 10     | 꺼짐        |
| `res_s10_0.json`  | `s10:0:13`       | s10 `[0:13)` 13     | 꺼짐        |
| `res_s10_13.json` | `s10:13`         | s10 `[13:26)` 13    | 꺼짐        |

- 기본 출력명 규칙은 `res_<그룹>_<lo>.json`이라 `res_s1.json`(`_0` 없음)만 `=res_s1.json`으로 이름을 지정한다(`--out`도 SPEC이 하나일 때 같은 역할).
- **`res_s1.json`의 원본 명령은 추정이다.** 이전 구현의 그룹 전체 명령(`s1`, 출력명 `res_s1_0.json`)에서 파일명만 바꾼 것으로 본다. 근거: 기준 파일의
  케이스 키 목록이 `cases.json`의 그룹 `s1` 전체와 같고, 다른 6파일의 명령은 재생성으로 바이트 동일이 확인됐다. 기준 파일이 더 이른 판의 산출물이라는
  근거는 cwd 오염 이름 14개다(아래).

## 명령

### rd-016 명령 (기준 6파일 + 보조 진단)

```bash
O=/임의/출력/폴더/rd-016
mkdir -p "$O"

# A. pty 캡처 → res_import.json, res_import_extra.json (약 5분 12초)
$VPY $TOOLS/runcases_import.py import import_extra --dir "$O" --python "$P"

# B·C. 입력 줄 목록 → lines_B.json, lines_C.json
$VPY $TOOLS/make_lines_B.py --dir "$O"
$VPY $TOOLS/make_lines_C.py --dir "$O"

# B·C. 네이티브(대상 python3.14) 프로브 → native_result.json(B), native_result_C.json(C)
$VPY $TOOLS/native_complete.py "$O/lines_B.json" "$O/native_result.json" --python "$P"
$VPY $TOOLS/native_complete.py "$O/lines_C.json" "$O/native_result_C.json" --python "$P"

# B·C. pyodide 프로브(node) → pyodide_result.json(B), pyodide_result_C.json(C). C. 게이트 정규식 JS 평가 → gate_js_C.json
node $TOOLS/pyodide_complete.mjs "$O/lines_B.json" "$O/pyodide_result.json"
node $TOOLS/pyodide_complete.mjs "$O/lines_C.json" "$O/pyodide_result_C.json"
node $TOOLS/gate_js.mjs "$O/lines_C.json" "$O/gate_js_C.json"

# B. 조립 → native_vs_pyodide.json(+meta).  C. 조립 → gate_corpus.json(+meta)
$VPY $TOOLS/compare_native_pyodide.py --dir "$O"
$VPY $TOOLS/build_gate_corpus.py --dir "$O"

# 보조 진단(기준 대조 대상 아님. 실행되어 산출물이 나오는 것까지만 본다)
node $TOOLS/pyodide_zip_patch_check.mjs --dir "$O"
$VPY $TOOLS/verify_expectations.py --dir "$O"
$VPY $TOOLS/make_summary.py --dir "$O"
```

기준 대조와 자기 대조(결정성):

```bash
python3 $TOOLS/compare_baseline.py apps/demo/e2e/pty/rd-016 "$O" --json "$O/compare.json"    # 기준 6파일. 종료 코드 0이어야 한다
python3 $TOOLS/compare_baseline.py <이전 실행 출력 폴더> "$O"                                   # 같은 도구로 2회 실행한 결과끼리
```

### rd-015 명령 (기준 7파일)

```bash
O=/임의/출력/폴더/rd-015
$VPY $TOOLS/runcases.py s1=res_s1.json s2 s7:0:11 s7:11:22 s7:22 s10:0:13 s10:13 --dir "$O" --python "$P"   # pty, 약 9분 25초
```

기준 대조. `res_s1.json`의 옵션(14개 이름)은 "허용 차이"를 읽은 뒤에만 쓴다.

```bash
python3 $TOOLS/compare_baseline.py apps/demo/e2e/pty/rd-015 "$O" \
  --files res_s1.json res_s2_0.json res_s7_0.json res_s7_11.json res_s7_22.json res_s10_0.json res_s10_13.json \
  --ignore-baseline-candidates res_s1.json=common,hook_startup,ptyrepl,pyodide_console,pyodide_rlcompleter,runcases,s1,s2,s3,s3b,s4,s5,s6,s7 \
  --json "$O/compare.json"
```

옵션 없이 돌리면 종료 코드 1(`res_s1.json` 판정값 차이 205건)이고 나머지 6파일은 차이 0이다.

## 실행 소요 시간

측정: 2026-09-26, WSL2(Linux 6.6), node v24.20.0, 하니스 venv(pyte 0.8.2·wcwidth 0.8.4), 각 파이프라인 2회. 시간은 대부분 케이스마다 새 pty를
띄우고 출력이 멈추기를 기다리는 대기(`settle`)이며 CPU 시간이 아니다. 부하가 높은 환경에서는 늘 수 있다.

| 단계                                                                    | run1(초) | run2(초) | 비고                                                       |
| ----------------------------------------------------------------------- | -------- | -------- | ---------------------------------------------------------- |
| rd-016 A pty(`runcases_import.py`)                                      | 312.1    | 312.6    | 41케이스, 케이스당 약 7.6초                                |
| rd-016 `make_lines_B/C.py`                                              | 0.0      | 0.0      |                                                            |
| rd-016 `native_complete.py` B·C                                         | 0.2·0.1  | 0.2·0.1  |                                                            |
| rd-016 `pyodide_complete.mjs` B·C                                       | 1.1·1.0  | 1.2·1.0  | pyodide 로드 포함                                          |
| rd-016 `gate_js.mjs`·`compare_native_pyodide.py`·`build_gate_corpus.py` | 0.0      | 0.0      |                                                            |
| rd-016 `pyodide_zip_patch_check.mjs`                                    | 1.1      | 1.1      | 보조 진단                                                  |
| rd-016 `verify_expectations.py`·`make_summary.py`                       | 0.0      | 0.0      | 보조 진단                                                  |
| rd-015 `runcases.py`(7파일 한 번에)                                     | 565.2    | 566.0    | 70케이스(s1 10 + s2 2 + s7 32 + s10 26), 케이스당 약 8.1초 |

재측정 비용 예측: rd-016 약 5분 16초 + rd-015 약 9분 25초, 합계 약 15분. pty 실행이 전부이고 node·pyodide 단계는 합쳐 약 4초다.

## 허용 차이

기준 대조에서 판정값 차이는 **0을 요구한다**. 차이가 나오면 도구 복원 실패이거나 편차 18·19의 전제가 깨진 것이므로 고치려 들지 말고 사용자에게
올린다(`compare_baseline.py` 종료 코드 1). 아래는 사유와 함께 기록하고 진행하는 차이다.

| 파일                                                                         | 차이                                                 | 종류                  | 사유                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rd-016/native_vs_pyodide.meta.json`                                         | `/native/cwd`                                        | 환경 유래             | 실행마다 다른 임시 폴더. 기준값도 그 시점의 임시 폴더                                                                                                                                                              |
| 같은 파일                                                                    | `/native/stdlib_path`, `/native/sys_path/1..4`       | 환경 유래             | 기준값은 이전 세션 scratchpad 아래에 설치한 3.14.4 경로라 **재현 불가능**하다. 재생성값은 이 환경의 uv 설치 경로다. 같은 빌드(`3.14.4 (main, Apr 14 2026, 14:26:14) [Clang 22.1.3 ]`)여서 `python` 문자열은 같았다 |
| `rd-016/*.meta.json`                                                         | `env_*_top_level`(환경 전용 최상위 모듈 집합)        | 환경 유래로 기록      | 대상 인터프리터의 site-packages·cwd에 따라 달라진다(TRAP-27). 이번 실측은 차이 0이었다. 분류 결과(`counts`·`env`/`zip stdlib`/`기타`)가 바뀌면 판정값 차이로 따로 잡힌다                                           |
| `rd-015/res_s1.json`                                                         | `impor` 케이스의 기준 후보 14개 이름, `screen2` 22행 | 사용자 확정 (a), 아래 | 측정 당시 하니스 폴더의 `.py` 파일명이 모듈 후보에 섞였다(TRAP-27 계열)                                                                                                                                            |
| `rd-015/res_s1.json`                                                         | 원본 출력명 `res_s1_0.json` ≠ 기준 `res_s1.json`     | 파일명 불일치         | SPEC `s1=res_s1.json`으로 이름을 맞추고 내용으로 판정한다                                                                                                                                                          |
| `SUMMARY-import.md`·`expectations_check.json`·`pyodide_zip_patch_check.json` | -                                                    | 대조 대상 아님        | 서술·보조 산출물. 실행되어 산출물이 나오는 것까지만 본다                                                                                                                                                           |

이 밖에 `pyodide_version`(`native_vs_pyodide.meta.json`의 `pyodide.version`)은 이번에 기준과 같은 `314.0.7`이었다. 값이 달라도 판정에 넣지 않고 환경 유래 표에만
기록된다.

### `res_s1.json`: 기준 후보 14개 제외 (사용자 확정 2026-09-26)

- **원인**: 기준 `res_s1.json`의 `impor` 케이스(입력 `impor` + Tab 두 번)는 두 번째 Tab의 후보(`log[1].res`)가 206개다. 빈 임시 cwd로 재생성하면 192개다.
  차이 14개는 정확히 측정 당시 하니스 폴더의 `.py` 파일명이다: `common`, `hook_startup`, `ptyrepl`, `pyodide_console`, `pyodide_rlcompleter`, `runcases`, `s1`,
  `s2`, `s3`, `s3b`, `s4`, `s5`, `s6`, `s7`. 기준에서 이 14개를 빼면 재생성 `res`와 순서까지 같다(`log[0]`·`log[1]` 모두, run1·run2 모두).
  이 하니스는 자식 REPL의 cwd를 빈 임시 폴더로 고정하므로(TRAP-27) 이 파일은 바이트 동일이 될 수 없다.
- **처리**: `--ignore-baseline-candidates res_s1.json=<14개>`로 기준 `res`에서만 그 이름을 빼고 엄격 비교한다. `res`·`typed`·`cursor1`·`screen1`·나머지 9케이스는
  차이 0이다. `screen2`의 22행(`/impor/screen2/1..22`: 열 배치와 마지막 `N more...` 줄)은 환경 유래 표로 옮긴다. 열 폭이 가장 긴 후보 이름으로 정해지기
  때문이다(기준은 `pyodide_rlcompleter` 19자라 열 폭 21·3열, 재생성은 `multiprocessing` 15자라 17·4열, `N more...` 144 대 108).
- **옮기는 규칙**: 그 화면(첫 줄 입력행과 마지막 `N more...` 줄 제외)의 모든 단어가 해당 쪽 케이스 `log`의 `res` 원소일 때만 옮긴다.
- **위험**:
  - 제외 목록이 실제 판정값 차이를 가릴 수 있다. 그래서 목록을 파일별 실행 인자로 명시하고, 옵션 사용 요약을 출력·`--json`(`ignored_baseline_candidates`)에 남기며,
    사용되지 않은 이름(기준 어디에서도 못 뺀 이름)과 재생성에도 있는 이름은 판정값 차이로 남긴다. 양성 대조: 이름 13개(`s7` 뺌)는 종료 코드 1(판정 67),
    없는 이름 `zzz` 추가는 종료 코드 1(판정 1), 재생성에도 있는 `abc` 추가는 종료 코드 1(판정 192).
  - `screen2` 열 배치 차이가 실제 렌더 결함이었다면 가려진다. `_pyrepl`의 열 배치 알고리즘을 재현해 제외 후 화면을 다시 그리지 않았고, 옮기는 조건은
    단어 소속 검사뿐이다. 기준의 `N more...`(144)와 표시된 63개를 합하면 207이라 후보 206개와 1 어긋나 합계 검사는 못 쓴다(재생성은 84+108=192로 일치).
  - `impor` 케이스는 브라우저 셀 판정 리터럴 출처가 아니다(`verify/tab-check.mjs`의 C3·C10은 `res_s10_0.json`을 쓰고, 이 파일은 바이트 동일이다).
- 다른 6파일은 모듈 이름 목록을 완성하는 케이스가 없어 cwd와 무관하고 기준과 바이트 동일이다.

## 3.15 재측정 시 실행 순서

`docs/design/13-version-upgrade.md` 13.4(minor 절차) 3번에 대응한다. **재측정을 할지는 사용자가 정한다(ADR-0007).** 결정이 나면 별도 RD로 진행한다.

1. 새 인터프리터를 venv 밖에 설치한다(pyte·wcwidth 미설치). 하니스 venv는 그대로 쓴다.
2. `tools/ptyrepl.py`의 `EXPECTED_VERSION`(현재 `3.14.4`)과 `WHICH_NAME`(현재 `python3.14`)을 새 버전으로 바꾼다. 바꾸기 전에는 `--allow-version-mismatch`로만 진행되고,
   결과에는 불일치 경고가 남는다. `--python`으로 대상을 명시하면 `WHICH_NAME`은 쓰이지 않는다.
3. 새 pyodide를 `pnpm install`로 설치하거나 `--pyodide <폴더>`로 지정한다. 실행 로그 첫 줄의 `package.json version`을 보관한다.
4. 새 빈 출력 폴더에서 위 "rd-016 명령"을 실행한다(약 5분 16초), 이어서 "rd-015 명령"을 실행한다(약 9분 25초). 각 명령은 2회 실행해 자기 대조에서
   판정값 차이 0을 확인한다(결정성 사전 점검).
5. 새 결과와 저장소 기준 데이터를 `compare_baseline.py`로 대조한다. 이때 차이는 "재생성 실패"가 아니라 **3.14.4 대 새 버전의 변경 목록**이다. 판단 자료
   (`13-version-upgrade.md` 13.5)에 차이 표를 넣고 편차·함정을 전수 재검토한다.
6. **새 측정에서는 `--ignore-baseline-candidates`가 필요 없다.** 빈 임시 cwd로 만든 `res_s1.json`이 새 기준이다. 기준 데이터 교체, `BASELINE.md`·편차 갱신은 재측정 RD의
   범위이고 이 문서의 범위 밖이다.
7. 새 대상에서 `ptyrepl.py --check-only`가 통과하고 셀프테스트(`os.getc` + Tab → `os.getcwd`)가 실패하면 `_pyrepl` 키 동작이 바뀐 것이므로, 케이스를 돌리기 전에
   셀프테스트 기대(`os.getcwd` 행)부터 다시 확인한다.
