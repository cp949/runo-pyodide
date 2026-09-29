"""측정 C 산출물을 조립해 게이트 코퍼스(`gate_corpus.json`·`gate_corpus.meta.json`)를 만든다(RD-016).

사용: python3 build_gate_corpus.py --dir <작업 폴더>
- 입력(작업 폴더에 있어야 한다): `lines_C.json`·`gate_js_C.json`·`native_result_C.json`·`pyodide_result_C.json`.
- 출력(같은 폴더): `gate_corpus.json`·`gate_corpus.meta.json`. 요약(meta)은 stdout에도 낸다.
- 순수 JSON 조립이라 어느 파이썬으로 돌려도 같다.
- 게이트: 커서 앞 텍스트에 JS 정규식 `/\\b(import|from)\\b/`가 맞는가.
- 분류는 게이트 판정과 ModuleCompleter 결과(None 여부)의 조합이다(`klass()`).
- 파이프라인 위치는 pty/tools/README.md "의존 관계(rd-016)"다.
"""
import argparse
import json
import os
import re

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("--dir", required=True, help="작업 폴더(입력 4개를 읽고 결과 2개를 쓴다)")
here = os.path.abspath(ap.parse_args().dir)
L = lambda n: json.load(open(os.path.join(here, n)))
# 입력 4개는 줄 순서가 같다. 개수가 다르면 조립하지 않는다.
lines, gjs, nat, pyo = L("lines_C.json"), L("gate_js_C.json"), L("native_result_C.json"), L("pyodide_result_C.json")
assert len(lines) == len(gjs) == len(nat["rows"]) == len(pyo["rows"])
# 게이트의 파이썬 판. 교차 확인용이다.
# 파이썬 re의 \b는 유니코드를 인식해서 JS의 \b와 다르게 판정할 수 있다.
GATE_PY = re.compile(r"\b(import|from)\b")

def kind(r):
    """프로브 결과를 종류 문자열로 줄인다: `None`, `[]`, `list(N)`."""
    return "None" if r is None else ("[]" if r == [] else f"list({len(r)})")

def klass(gate, r):
    """게이트 판정(`gate`)과 프로브 결과(`r`)의 조합을 분류 이름으로 돌려준다.

    - 게이트 거짓·None: 건전(게이트가 막은 줄을 ModuleCompleter도 판정하지 않는다).
    - 게이트 거짓·비None: 예외(게이트가 막았지만 ModuleCompleter는 판정한다).
    - 게이트 참·None: 오탐(왕복만 늘고 동작은 같다).
    - 게이트 참·비None: 참 양성 또는 `[]`.
    """
    if gate:
        return "gate 참·None(오탐)" if r is None else "gate 참·비None(참 양성 또는 [])"
    return "gate 거짓·None(건전)" if r is None else "gate 거짓·비None(예외)"

# 줄 텍스트를 키로 줄마다 한 행을 만든다. 환경별(native·pyodide) 분류를 함께 싣는다.
out = {}
for m, g, n, p in zip(lines, gjs, nat["rows"], pyo["rows"]):
    assert m["line"] == n["line"] == p["line"]
    row = {"id": m["id"], "tag": m["tag"], "note": m["note"], "gate_js": g, "gate_py": bool(GATE_PY.search(m["line"])),
           "native_kind": kind(n["result"]), "native_head": None if n["result"] is None else n["result"][:6],
           "pyodide_kind": kind(p["result"]), "pyodide_head": None if p["result"] is None else p["result"][:6],
           "parse_native": n["parse"], "parse_pyodide": p["parse"],
           "class_native": klass(g, n["result"]), "class_pyodide": klass(g, p["result"])}
    out[m["line"]] = row
json.dump(out, open(os.path.join(here, "gate_corpus.json"), "w"), ensure_ascii=False, indent=1)

def lst(cls, env):
    """`env`(native|pyodide)에서 분류가 `cls`인 줄 목록."""
    return [line for line, r in out.items() if r[f"class_{env}"] == cls]
# 분류 순서는 meta 키(`gate_false_non_none_*`·`gate_true_none_*`)가 classes[1]·classes[2]를 가리킨다.
classes = ["gate 거짓·None(건전)", "gate 거짓·비None(예외)", "gate 참·None(오탐)", "gate 참·비None(참 양성 또는 [])"]
# 요약.
# compare_baseline.py는 아래 키를 판정값으로 비교한다.
# `counts*`, `*_differs*`, `gate_false_non_none_*`, `gate_true_none_*`, `sys_modules_*`.
meta = {
    "cases": len(out),
    "gate_regex_js": "/\\b(import|from)\\b/ (플래그 없음)",
    "counts_native": {c: len(lst(c, "native")) for c in classes},
    "counts_pyodide": {c: len(lst(c, "pyodide")) for c in classes},
    "gate_false_non_none_native": lst(classes[1], "native"),
    "gate_false_non_none_pyodide": lst(classes[1], "pyodide"),
    "gate_true_none_native": lst(classes[2], "native"),
    "gate_true_none_pyodide": lst(classes[2], "pyodide"),
    "native_vs_pyodide_differs": [line for line, r in out.items() if r["native_kind"] != r["pyodide_kind"]],
    "gate_js_vs_py_differs": [line for line, r in out.items() if r["gate_js"] != r["gate_py"]],
    "sys_modules_added": {"native": nat["sys_modules_added"], "pyodide": pyo["sys_modules_added"]},
    "sys_modules_removed": {"native": nat["sys_modules_removed"], "pyodide": pyo["sys_modules_removed"]},
    "result_pkgnone_differs_native": [m["line"] for m, n in zip(lines, nat["rows"]) if n["result_pkgnone_differs"]],
    "result_pkgnone_differs_pyodide": [m["line"] for m, p in zip(lines, pyo["rows"]) if p["result_pkgnone_differs"]],
}
json.dump(meta, open(os.path.join(here, "gate_corpus.meta.json"), "w"), ensure_ascii=False, indent=1)
print(json.dumps(meta, ensure_ascii=False, indent=1))
