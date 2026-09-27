"""측정 결과 JSON에서 SUMMARY-import.md를 생성한다(표는 전부 JSON에서 만든다. 서술 절만 이 파일에 고정 문장으로 들어 있다).
사용: python3 make_summary.py --dir <작업 폴더>
작업 폴더의 측정 결과 JSON(res_import*, native_vs_pyodide*, gate_corpus*, expectations_check, pyodide_zip_patch_check)을 읽어 SUMMARY-import.md를 같은 폴더에 쓴다.
서술 산출물이라 기준 대조 대상이 아니다.
"""
import argparse
import json
import os

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("--dir", required=True, help="작업 폴더")
here = os.path.abspath(ap.parse_args().dir)
L = lambda n: json.load(open(os.path.join(here, n)))
A, AX = L("res_import.json"), L("res_import_extra.json")
B, BM = L("native_vs_pyodide.json"), L("native_vs_pyodide.meta.json")
C, CM = L("gate_corpus.json"), L("gate_corpus.meta.json")
E = L("expectations_check.json")
ZP = L("pyodide_zip_patch_check.json")


def cell(s):
    return str(s).replace("|", "\\|").replace("\n", "\\n")


def code(s):
    return "`" + cell(s) + "`"


def lst(x, n=4):
    """None / [] / 목록을 표 셀용 문자열로."""
    if x is None:
        return "None"
    if x == []:
        return "[]"
    head = ", ".join(repr(i) for i in x[:n])
    return f"[{head}{', …' if len(x) > n else ''}] ({len(x)})"


def kind(x):
    return "None" if x is None else ("[]" if x == [] else f"list({len(x)})")


def table(headers, rows):
    out = ["| " + " | ".join(headers) + " |", "|" + "|".join("---" for _ in headers) + "|"]
    out += ["| " + " | ".join(cell(c) if not str(c).startswith("`") else str(c) for c in r) + " |" for r in rows]
    return "\n".join(out)


def a_rows(data):
    rows = []
    for text, r in data.items():
        st1 = r["steps"][0]
        e = st1["log"][0] if st1["log"] else None
        delta = st1["cursor"][1] - r["typed_cursor"][1] if st1["cursor"][0] == r["typed_cursor"][0] else "줄 이동"
        screen = " / ".join(st1["screen"][r["typed_cursor"][0]:])
        if r["tabs"] > 1:
            s2 = r["steps"][1]["screen"]
            screen += f" ; Tab2: 메뉴 {len(s2) - 1}줄(끝 줄 `{s2[-1].strip()}`)"
        rows.append([
            r["id"], code(repr(text)) + f" ({r['tabs']})",
            code(repr(e["stem"])) if e else "-",
            kind(e["mc"]) if e else "-",
            lst(e["res"]) if e else "-",
            f"+{delta}" if isinstance(delta, int) else delta,
            code(screen),
        ])
    return rows


def b_diff_rows():
    rows = []
    for line, r in B.items():
        if r["same"]:
            continue
        d = r["diff"]
        short = lambda xs: (", ".join(xs[:5]) + (f", …(+{len(xs) - 5})" if len(xs) > 5 else "")) if xs else "-"
        rows.append([r["id"], code(repr(line)), d["class"], kind(r["native"]), kind(r["pyodide"]), short(d["native_only"]), short(d["pyodide_only"])])
    return rows


def c_rows():
    rows = []
    for line, r in C.items():
        rows.append([r["id"], code(repr(line)), "참" if r["gate_js"] else "거짓", kind_from(r["native_kind"], r["native_head"]),
                     r["pyodide_kind"], r["class_native"]])
    return rows


def kind_from(k, head):
    return k if head is None or k == "[]" else f"{k} {head[:2]}"


def e_rows():
    def show(x):
        s = json.dumps(x, ensure_ascii=False)
        return s if len(s) <= 60 else s[:57] + "…"
    return [[r["item"], code(show(r["expected"])), code(show(r["actual"])), "일치" if r["match"] else "**불일치**", r["note"]] for r in E]


n_match = sum(r["match"] for r in E)
c = BM["counts"]
bo = BM["counts_by_origin"]
md = f"""# RD-016a DELTA-01 3.14 실측 재현 (import/from 줄 Tab 완성)

- 측정 일자: 2026-09-21. 기준: CPython {BM['native']['python'].split()[0]}(네이티브 pty·직접 호출) 대 pyodide {BM['pyodide']['version']}(Python {BM['pyodide']['python'].split()[0]}, Node).
- 이 파일은 `make_summary.py`가 JSON에서 생성한다. 원자료: `res_import.json`(A), `native_vs_pyodide.json`(B), `gate_corpus.json`(C).

## 1. 결론

- 케이스 수: 측정 A {len(A)}(+추가 {len(AX)}), 측정 B {BM['cases']}, 측정 C {CM['cases']}. 모두 DELTA-01 계획 이상.
- 기대값 {len(E)}항목 중 일치 {n_match}, 불일치 {len(E) - n_match}. 후보·화면 기대값은 전부 재현됐다. 불일치는 측정 B 카운트 5항목(사전 조사의 65케이스 줄 목록이 저장되지 않아 케이스 집합이 다름)과
  네이티브 전용 밑줄 모듈 17개(기대 목록에 없음) 1항목이다. 7절.
- 측정 B: {BM['cases']}케이스 중 동일 {c['same']}, 차이 {c['diff']}(환경 모듈 집합 {c['env']}, zip stdlib 로직 {c['zip stdlib']}, 기타 {c['기타']}). `ImportParser` 파싱 결과는 {BM['cases']}줄 전부 네이티브와 pyodide가 같다(불일치 {c['parse 불일치']}).
- 측정 C: 게이트(`/\\b(import|from)\\b/`)가 거짓인 {CM['counts_native']['gate 거짓·None(건전)'] + CM['counts_native']['gate 거짓·비None(예외)']}줄 중 네이티브가 `None`이 아닌 예외 {CM['counts_native']['gate 거짓·비None(예외)']}줄:
  전부 숫자 리터럴 바로 뒤에 `import`/`from`이 붙은 입력(`1import os`)이다. 게이트 참·`None`(오탐) {CM['counts_native']['gate 참·None(오탐)']}줄.

### 사전 조사 기대값과 달라서 설계에 영향이 있는 관찰

1. **후보가 cwd에 의존한다.** REPL의 `sys.path[0]`가 `''`라 `ModuleCompleter`가 cwd의 `.py` 파일·패키지를 모듈 후보로 나열한다. 하니스 폴더에서 pty를 띄우면 `import ` 후보가 192개가 아니라 196개
   (`common`·`hook_startup`·`ptyrepl`·`runcases_import` 추가)가 된다. 이 하니스는 자식 REPL의 cwd를 빈 임시 폴더로 고정해 192개를 얻는다. pyodide는 `sys.path[0] == ''`, cwd `{BM['pyodide']['cwd']}`이므로
   MEMFS cwd의 파일도 후보에 섞이는 것이 3.14와 같은 동작이다. 시험은 후보 개수·전체 목록을 단정하지 말 것.
2. **삽입 규칙은 `후보[len(스템):]`이고 스템은 `get_stem()`(구분자 기반)이다. 파싱 결과와 스템이 어긋나면 3.14 자체가 이상한 삽입을 한다.**
   `import os.pa  # c` Tab -> `import os.pa  # cs.path`, `from os import path,` Tab -> `from os import path,path`, `import os.pa\\n` Tab -> 둘째 줄에 `os.path`, `import os  # c\\n` Tab -> 둘째 줄에 `os`. 4절 표.
3. **zip stdlib 차이는 4줄이다**(기대는 2줄). `from xml.parsers.expat import `, `import xml.parsers.expat.`도 pyodide에서 `[]`이다. 원인은 같다(`_is_stdlib_module`이 `FileFinder`만 stdlib로 인정해
   `zipimporter`인 pyodide에서 `HARDCODED_SUBMODULES`가 빠진다). 참고 진단: `_is_stdlib_module`만 오버라이드한 서브클래스로 {len(ZP['fixed_by_patch'])}줄이 네이티브와 같아지고 퇴행 {len(ZP['regressed'])}줄
   (`pyodide_zip_patch_check.json`; 채택 여부는 DELTA-02a에서 판단).
4. **`sys.modules`는 변하지 않는다.** 측정 B {BM['cases']}줄·C {CM['cases']}줄 실행 전후 추가·삭제 모듈 0개(네이티브·pyodide 모두). 설계 Q4 전제 확인.
5. **`ModuleCompleter()`와 `ModuleCompleter(namespace={{'__package__': None}})`(pty가 쓰는 `make_default_module_completer()`)는 {BM['cases']}+{CM['cases']}줄에서 결과가 같다**(네이티브·pyodide 모두 차이 0줄).
   pty 훅의 `mc`(ModuleCompleter 원시 결과)와 측정 B 네이티브 직접 호출 결과도 A {len(A)}줄 + 추가 {len(AX)}줄에서 전부 같다.

## 2. 재현 명령

이 저장소의 재생성 도구(`apps/demo/e2e/pty/tools/`)를 쓴다. 전제: 하니스 venv(`pyte==0.8.2`·`wcwidth==0.8.4`, `tools/requirements.txt`), 대상 인터프리터 CPython 3.14.4(`--python` > `PTY_PYTHON` > PATH의 `python3.14`),
`node`, pnpm 설치 상태의 pyodide(`--pyodide <폴더>`로 재정의). 자세한 절차와 실행 시간은 `apps/demo/e2e/pty/REGEN.md`. pty 측정 A는 케이스 41개를 한 프로세스에서 돌린다.

```bash
VPY=<하니스 venv>/bin/python       # 활성화하지 않고 절대경로로 호출한다
OUT=<작업 폴더>                    # 산출물 폴더(저장소 기준 데이터 폴더를 쓰지 않는다)
TOOLS=apps/demo/e2e/pty/tools

# 측정 B: 네이티브 대 pyodide  -> native_vs_pyodide.json(+ .meta.json)
$VPY $TOOLS/make_lines_B.py --dir $OUT
$VPY $TOOLS/native_complete.py $OUT/lines_B.json $OUT/native_result.json
node $TOOLS/pyodide_complete.mjs $OUT/lines_B.json $OUT/pyodide_result.json
$VPY $TOOLS/compare_native_pyodide.py --dir $OUT

# 측정 C: 게이트 코퍼스  -> gate_corpus.json(+ .meta.json)
$VPY $TOOLS/make_lines_C.py --dir $OUT
node $TOOLS/gate_js.mjs $OUT/lines_C.json $OUT/gate_js_C.json
$VPY $TOOLS/native_complete.py $OUT/lines_C.json $OUT/native_result_C.json
node $TOOLS/pyodide_complete.mjs $OUT/lines_C.json $OUT/pyodide_result_C.json
$VPY $TOOLS/build_gate_corpus.py --dir $OUT

# 측정 A: pty 화면 실측  -> res_import.json, res_import_extra.json (부분 실행: --lo/--hi, 단일 그룹만)
$VPY $TOOLS/runcases_import.py import import_extra --dir $OUT

# 참고 진단(zip stdlib 오버라이드), 기대값 대조, 이 문서 재생성
node $TOOLS/pyodide_zip_patch_check.mjs --dir $OUT
$VPY $TOOLS/verify_expectations.py --dir $OUT && $VPY $TOOLS/make_summary.py --dir $OUT

# 기준 데이터와 대조(종료 코드 0 = 판정값 차이 없음)
$VPY $TOOLS/compare_baseline.py apps/demo/e2e/pty/rd-016 $OUT
```

## 3. 하니스와 재현성

- 인터프리터: 시작 시 대상의 `sys.version`을 읽어 기대 버전(3.14.4)과 다르면 중단한다(`--allow-version-mismatch`로만 진행). 대상이 venv이거나 `pyte`·`wcwidth`가 설치돼 있으면 중단한다(자식 후보 집합 오염, TRAP-27).
- `pyte`·`wcwidth`는 하니스를 돌리는 venv에만 설치한다(`pyte`는 LGPLv3라 저장소에 벤더링하지 않는다). 자식 REPL에는 노출되지 않는다.
- pyodide는 `tools/resolve_pyodide.mjs`가 `--pyodide` > `createRequire('pyodide')` > 워크스페이스 `packages/*/node_modules/pyodide` 순으로 찾고, 결과 JSON의 `pyodide_version`에 `package.json`의 version을 기록한다.
- pty 조건: 24x80, `TERM=xterm`, `PYTHON_COLORS=0`, `NO_COLOR=1`, 임시 `HOME`·`PYTHON_HISTORY`, 자식 cwd는 빈 임시 폴더로 고정(cwd 파일이 모듈 후보에 섞이지 않게), 케이스마다 새 세션에서 SETUP 5줄(`import os` 등) 실행 뒤 Ctrl+L. 다중 줄 입력은 bracketed paste. Tab 사이 대기 0.5초(pyte 렌더링 정착).
- 훅의 `mc` 필드(ModuleCompleter 원시 결과)는 `--with-mc`(`runcases_import.py`는 기본 켬)로 기록한다.
- 측정 B·C의 네이티브 실행은 REPL과 같은 조건이다: `sys.path[0] = ''`(스크립트 폴더 아님), 빈 임시 cwd. pyodide는 `loadPyodide()` 기본 상태(cwd `/home/pyodide` 비어 있음).
- 시각·경로 의존 필드: `native_vs_pyodide.meta.json`, `gate_corpus.meta.json`, `native_result*.json`의 `cwd`는 실행마다 임시 경로가 다르다. 그 외 결과 JSON은 결정적이다.
- pyodide 번들은 Python 3.14.2, 기준 pty는 3.14.4다. 이 측정에서 파서 결과는 {BM['cases']}줄 전부 같았고 후보 차이는 5절 분류 안에서 설명된다. 3.14.2 대 3.14.4 소스 차이 자체는 이 측정으로 배제되지 않는다.

## 4. 측정 A: pty 화면 실측 ({len(A)}케이스)

`MC` = hook이 다시 호출한 `get_module_completions()` 원시 결과(None = 폴백, `[]` = 무동작, list = 후보). `res` = 최종 후보(폴백 포함). `삽입` = Tab 1회 뒤 커서 이동 칸 수. 화면은 Tab 1회 뒤 커서 줄부터 아래.

{table(['ID', '입력 (Tab)', '스템', 'MC', 'res', '삽입', 'Tab 뒤 화면'], a_rows(A))}

관찰:

- `MC`가 `None`이고 스템이 비면 `res = [' ' * (4 - 열 % 4)]` 한 개(A22 2칸, A23 1칸, A24 4칸). `MC`가 `[]`이면 `res`도 `[]`이고 화면 무변화(A14~A21). 대조군 `x = 1`은 `MC` `None` -> rlcompleter `[]` -> 무변화(A27).
- 후보 1개면 즉시 삽입, 여러 개면 공통 접두사만 삽입하고 `[ not unique ]`, 두 번째 Tab이 열 우선 메뉴를 그린다(A11: 24행 화면에서 메뉴 단어 21줄 + `108 more...` 줄).
- `import `·`from `·`yield from ` 빈 스템은 192개(빈 cwd), `import o`·`from o`·`yield from o`·`raise ValueError from o`는 4개(`opcode`, `operator`, `optparse`, `os`).
- `ModuleCompleter` 입력은 `buffer[:pos]` 전체(다중 줄 포함)다. `x = 1\\nimport o`(A30), `if True:\\n    import o`(A31)가 모듈 완성이 된다.

### 측정 A 추가: 스템과 파싱이 어긋나는 입력 (`import_extra`)

{table(['ID', '입력 (Tab)', '스템', 'MC', 'res', '삽입', 'Tab 뒤 화면'], a_rows(AX))}

## 5. 측정 B: 네이티브 3.14.4 대 pyodide 314.0.7 ({BM['cases']}케이스)

결과 형식: `null` = `None`, `[]` = 무동작, 목록 = 후보(`native_vs_pyodide.json`의 `native`·`pyodide`, 종류는 `*_kind`). 입력 줄은 `lines_B.json`.

### 카운트

| 구분 | 케이스 | 동일 | 차이 | 환경 | zip stdlib | 기타 |
|---|---|---|---|---|---|---|
| 전체 | {BM['cases']} | {c['same']} | {c['diff']} | {c['env']} | {c['zip stdlib']} | {c['기타']} |
""" + "\n".join(f"| {k} | {v['cases']} | {v['same']} | {v['diff']} | {v['env']} | {v['zip stdlib']} | {v['기타']} |" for k, v in bo.items()) + f"""

분류 규칙(`compare_native_pyodide.py` 상단): env = 차이 항목이 전부 환경 전용 최상위 모듈(또는 그 서브모듈), zip stdlib = 네이티브에만 있는 항목이 전부 `HARDCODED_SUBMODULES` 확장, 기타 = 나머지.
`None` 대 목록의 판정 자체가 다른 줄과 파서 결과가 다른 줄은 기타로 센다(해당 0줄). 순서만 다른 줄 {c['순서만 다름']}줄.

### 차이 {c['diff']}줄

{table(['ID', '입력', '분류', '네이티브', 'pyodide', '네이티브 전용', 'pyodide 전용'], b_diff_rows())}

### 환경 모듈 집합 차이 (`import ` + `import _` 줄에서 도출)

- 네이티브에만 있음(밑줄 없음, {len([m for m in BM['env_native_only_top_level'] if not m.startswith('_')])}개): {', '.join('`' + m + '`' for m in BM['env_native_only_top_level'] if not m.startswith('_'))}
- 네이티브에만 있음(밑줄, {len([m for m in BM['env_native_only_top_level'] if m.startswith('_')])}개): {', '.join('`' + m + '`' for m in BM['env_native_only_top_level'] if m.startswith('_'))}
- pyodide에만 있음({len(BM['env_pyodide_only_top_level'])}개): {', '.join('`' + m + '`' for m in BM['env_pyodide_only_top_level'])}
- `import ` 후보 수: 네이티브 {len(B['import ']['native'])}, pyodide {len(B['import ']['pyodide'])}.

## 6. 측정 C: 게이트 건전성 코퍼스 ({CM['cases']}줄)

게이트 = `/\\b(import|from)\\b/`(JS, 플래그 없음)가 입력 텍스트에 매치되는가. 입력은 `lines_C.json`, 판정은 네이티브 `ModuleCompleter().get_completions`(pyodide도 같은 결과).

| 분류 | 네이티브 | pyodide |
|---|---|---|
""" + "\n".join(f"| {k} | {v} | {CM['counts_pyodide'][k]} |" for k, v in CM["counts_native"].items()) + f"""

- 게이트 거짓인데 `None`이 아닌 예외 {len(CM['gate_false_non_none_native'])}줄(네이티브·pyodide 동일): {', '.join(code(repr(l)) for l in CM['gate_false_non_none_native'])}. 전부 숫자 리터럴 바로 뒤에 키워드가 붙은 입력이다. 3.14의 `tokenize`가
  `NUMBER` + `NAME('import')`로 토큰화해 `ImportParser`가 받아들인다(문법 오류 입력). 이 예외 5줄 외의 게이트 거짓 {CM['counts_native']['gate 거짓·None(건전)']}줄은 전부 `None`이다.
- 게이트 참인데 `None`인 줄(오탐, 허용: 왕복만 늘어남) {len(CM['gate_true_none_native'])}줄: {', '.join(code(repr(l)) for l in CM['gate_true_none_native'])}.
- JS `\\b`와 파이썬 `re` `\\b`가 다르게 판정한 줄(JS 참, 파이썬 거짓; 안전한 방향): {', '.join(code(repr(l)) for l in CM['gate_js_vs_py_differs'])}.
- 네이티브 대 pyodide 판정 종류(None/[]/list)가 다른 줄: {len(CM['native_vs_pyodide_differs'])}줄.

{table(['ID', '입력', '게이트(JS)', '네이티브', 'pyodide', '분류(네이티브)'], c_rows())}

## 7. 기대값 대조 ({len(E)}항목, 일치 {n_match}, 불일치 {len(E) - n_match})

{table(['항목', '기대', '실측', '결과', '비고'], e_rows())}

측정 B 카운트 5항목이 불일치인 이유: 사전 조사의 65케이스 줄 목록이 저장되지 않았다. DELTA 명시 줄만(A 텍스트 {bo['A(측정 A 텍스트)']['cases']} + 추가 패턴 {bo['추가 패턴']['cases']} + 기대값 확인 {bo['기대값 확인']['cases']} = {bo['A(측정 A 텍스트)']['cases'] + bo['추가 패턴']['cases'] + bo['기대값 확인']['cases']}줄)
보면 차이 {bo['A(측정 A 텍스트)']['diff'] + bo['추가 패턴']['diff'] + bo['기대값 확인']['diff']}줄(환경 {bo['A(측정 A 텍스트)']['env'] + bo['추가 패턴']['env']}, zip {bo['A(측정 A 텍스트)']['zip stdlib'] + bo['추가 패턴']['zip stdlib']})이다.
환경 차이 14줄이라는 기대는 이 줄들만으로는 나오지 않는다(사전 조사에 알파벳별 접두사 줄 등 다른 줄이 있었던 것으로 추정하나 확인 불가). 환경 모듈 이름 집합(밑줄 없는 15개, pyodide 전용 8개)은 정확히 재현됐다.

## 8. 파일 목록 (이 폴더)

| 파일 | 내용 |
|---|---|
| `res_import.json` | 측정 A 결과({len(A)}케이스, 텍스트 키). 케이스마다 typed·steps[화면·커서·훅 기록] |
| `res_import_extra.json` | 측정 A 추가 {len(AX)}케이스(스템 불일치) |
| `native_vs_pyodide.json` | 측정 B 결과({BM['cases']}줄, 줄 텍스트 키). native·pyodide·parse·same·diff(분류) |
| `native_vs_pyodide.meta.json` | B 요약: 카운트, 출처별 카운트, 환경 모듈 집합, 인터프리터·`sys.path`·`sys.modules` 변화 |
| `gate_corpus.json` / `.meta.json` | 측정 C 결과({CM['cases']}줄)와 요약(예외·오탐 목록) |
| `expectations_check.json` | 기대값 {len(E)}항목 대조 |
| `pyodide_zip_patch_check.json` | 참고: `_is_stdlib_module` 오버라이드 진단 |
| `cases_import.json`, `lines_B.json`, `lines_C.json` | 입력 케이스(A 그룹 `import`·`import_extra`, B 줄, C 줄) |
| `native_result*.json`, `pyodide_result*.json`, `gate_js_C.json` | B·C 원시 프로브 출력 |
| `runcases_import.py`, `make_lines_B.py`, `make_lines_C.py`, `mc_probe.py`, `native_complete.py`, `pyodide_complete.mjs`, `gate_js.mjs`, `compare_native_pyodide.py`, `build_gate_corpus.py`, `verify_expectations.py`, `pyodide_zip_patch_check.mjs`, `make_summary.py` | 측정·조립 스크립트 |
| `ptyrepl.py`, `common.py`, `hook_startup.py`, `resolve_pyodide.mjs`, `compare_baseline.py` | 하니스·해석 헬퍼·기준 대조기(`pyte`·`wcwidth`는 하니스 venv에 설치) |
"""
open(os.path.join(here, "SUMMARY-import.md"), "w").write(md)
print("SUMMARY-import.md", len(md.splitlines()), "줄")
