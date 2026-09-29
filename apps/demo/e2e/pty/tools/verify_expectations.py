"""사전 조사 기대값(미저장)을 측정 결과에 대조해 `expectations_check.json`을 만든다(RD-016 보조 진단).

사용: python3 verify_expectations.py --dir <작업 폴더>
- 입력(작업 폴더에 먼저 있어야 한다):
  `res_import.json`·`res_import_extra.json`·`native_vs_pyodide.json`·`native_vs_pyodide.meta.json`.
- 출력: 같은 폴더의 `expectations_check.json`. 불일치 항목을 stdout에도 낸다.
- 기대값에 결과를 맞추지 않는다. 다르면 다른 대로 기록한다.
- 교차 확인도 한다. pty 훅의 `mc`와 측정 B 네이티브 직접 호출 결과가 A와 추가 케이스(41줄)에서 같은지 본다.
- 서술·보조 산출물이라 기준 대조 대상이 아니다. 실행되어 산출물이 나오는 것까지만 본다(pty/tools/README.md "도구와 입출력").
"""
import argparse
import json
import os

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("--dir", required=True, help="작업 폴더")
here = os.path.abspath(ap.parse_args().dir)
L = lambda n: json.load(open(os.path.join(here, n)))
A, AX, B, BM = L("res_import.json"), L("res_import_extra.json"), L("native_vs_pyodide.json"), L("native_vs_pyodide.meta.json")

# 항목마다 {item, expected, actual, match, note} 한 행을 쌓는다.
rows = []
def check(item, expected, actual, note=""):
    """기대값과 실측값을 비교해 `rows`에 한 행을 더한다. `note`는 불일치를 설명하는 부연이다."""
    rows.append({"item": item, "expected": expected, "actual": actual, "match": expected == actual, "note": note})

# 접근자. B는 줄 텍스트 키, A·AX는 입력 텍스트 키다.
nat = lambda line: B[line]["native"]
pyo = lambda line: B[line]["pyodide"]
pty_mc = lambda text: {**A, **AX}[text]["steps"][0]["log"][0]["mc"]
pty_stem = lambda text: A[text]["steps"][0]["log"][0]["stem"]
pty_screen = lambda text, tab=0: A[text]["steps"][tab]["screen"]
def inserted_cols(text):
    """A 케이스 `text`에서 Tab 1회로 커서가 오른쪽으로 움직인 칸 수(삽입된 글자 수)를 돌려준다."""
    return A[text]["steps"][0]["cursor"][1] - A[text]["typed_cursor"][1]

# --- 후보(네이티브 직접 호출, 측정 B)
check("`import ` 후보 수", 192, len(nat("import ")))
check("`from ` 후보 수", 192, len(nat("from ")))
check("`import os.p`", ["os.path"], nat("import os.p"))
check("`from os.p`", ["os.path"], nat("from os.p"))
for t in ["from os import p", "from os import ", "from os import ("]:
    check(f"`{t}`", ["path"], nat(t))
check("`import xml.dom.` 후보 수", 7, len(nat("import xml.dom.")))
for t in ["import os, sy", "import os as o, sy"]:
    check(f"`{t}` 스템(pty)", "sy", pty_stem(t))
    check(f"`{t}` 후보 수", 4, len(nat(t)))
check("`from xml.dom import m`", ["minicompat", "minidom"], nat("from xml.dom import m"))
check("`import os; os.pa`", None, nat("import os; os.pa"))
for t in ["import os; import s", "x = 1; import o", "x = 1\nimport o", "if True:\n    import o", "from os import (\n    p"]:
    r = nat(t)
    check(f"`{t!r}` 정상 모듈 완성(비어 있지 않은 목록)", True, isinstance(r, list) and len(r) > 0)
for t in ["from os import (path, s", "import zzzz", "import os.zzz", "from . import x", "from .a", "from .. import ", "from math import s", "from sys import "]:
    check(f"`{t}` = []", [], nat(t))
for t in ["import os ", "import os as x", "from os import path "]:
    check(f"`{t}` = None", None, nat(t))

# --- pty 화면(측정 A)
check("pty `import os ` -> 공백 2칸", 2, inserted_cols("import os "))
check("pty `import os.path ` -> 공백 1칸", 1, inserted_cols("import os.path "))
check("pty `from os import path ` -> 공백 4칸", 4, inserted_cols("from os import path "))
check("pty `from os import (\\n    path,\\n    ` 빈 스템 -> `path` 삽입", "...     path", pty_screen("from os import (\n    path,\n    ")[-1])
check("pty `yield from o` 후보 수", 4, len(pty_mc("def f():\n    yield from o")))
check("pty `yield from ` 후보 수", 192, len(pty_mc("def f():\n    yield from ")))
check("pty `import os  # c\\n` 다음 빈 줄 Tab -> `os` 삽입", "... os", pty_screen("import os  # c\n")[-1])

# --- 네이티브 대 pyodide
c = BM["counts"]
check("측정 B 케이스 수", 65, BM["cases"], "기대는 65개 이상. 사전 조사 줄 목록이 저장되지 않아 줄 목록이 다르다")
check("측정 B 동일 수", 49, c["same"], "케이스 집합이 달라 직접 비교 불가")
check("측정 B 차이 수", 16, c["diff"], "케이스 집합이 달라 직접 비교 불가")
check("측정 B 차이 중 환경 모듈 집합", 14, c["env"], "케이스 집합이 달라 직접 비교 불가")
check("측정 B 차이 중 zip stdlib", 2, c["zip stdlib"], "xml.parsers.expat 패턴 2줄이 추가로 걸림(같은 원인)")
exp_native_only = ["curses", "dbm", "ensurepip", "grp", "idlelib", "pip", "pwd", "pydoc_data", "readline", "resource", "syslog", "tkinter", "turtle", "turtledemo", "venv"]
exp_pyodide_only = ["pyodide", "_pyodide", "_pyodide_core", "_testbuffer", "_testcapi", "_testclinic", "_testclinic_limited", "_testlimitedcapi"]
act_native_only = BM["env_native_only_top_level"]
check("네이티브 전용 최상위 모듈(밑줄 없는 것)", sorted(exp_native_only), sorted(m for m in act_native_only if not m.startswith("_")))
check("네이티브 전용 최상위 모듈(밑줄 있는 것)", [], sorted(m for m in act_native_only if m.startswith("_")),
      "기대 목록에 없던 17개가 `import _`에서 나온다")
check("pyodide 전용 최상위 모듈", sorted(exp_pyodide_only), sorted(BM["env_pyodide_only_top_level"]))
for t in ["import collections.a", "from collections import a"]:
    check(f"pyodide `{t}` = []", [], pyo(t))

# --- pty 훅 mc == 네이티브 직접 호출(A 37줄 + 추가 4줄)
mism = [t for t in {**A, **AX} if pty_mc(t) != nat(t)]
check(f"pty 훅 mc == 네이티브 직접 호출(A {len(A)}줄 + 추가 {len(AX)}줄 중 불일치 수)", 0, len(mism), f"불일치: {mism}" if mism else "")
check("ModuleCompleter() 대 make_default_module_completer() 결과 차이 줄 수(B 네이티브·pyodide)", 0,
      len(BM["result_pkgnone_differs_native"]) + len(BM["result_pkgnone_differs_pyodide"]))

# 결과 저장과 요약 출력.
json.dump(rows, open(os.path.join(here, "expectations_check.json"), "w"), ensure_ascii=False, indent=1)
ok = sum(r["match"] for r in rows)
print(f"기대값 항목 {len(rows)}개: 일치 {ok}, 불일치 {len(rows) - ok}")
for r in rows:
    if not r["match"]:
        print("불일치:", r["item"], "| 기대", r["expected"], "| 실측", r["actual"], "|", r["note"])
