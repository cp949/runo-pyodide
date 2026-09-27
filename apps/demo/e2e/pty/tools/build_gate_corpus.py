"""lines_C.json + gate_js_C.json + native_result_C.json + pyodide_result_C.json -> gate_corpus.json(+ .meta.json).
사용: python3 build_gate_corpus.py --dir <작업 폴더>
작업 폴더에 lines_C.json·gate_js_C.json·native_result_C.json·pyodide_result_C.json이 있어야 하고, gate_corpus.json(+ .meta.json)을 같은 폴더에 쓴다.
순수 JSON 조립이라 어느 파이썬으로 돌려도 같다.
"""
import argparse
import json
import os
import re

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("--dir", required=True, help="작업 폴더(입력 4개를 읽고 결과 2개를 쓴다)")
here = os.path.abspath(ap.parse_args().dir)
L = lambda n: json.load(open(os.path.join(here, n)))
lines, gjs, nat, pyo = L("lines_C.json"), L("gate_js_C.json"), L("native_result_C.json"), L("pyodide_result_C.json")
assert len(lines) == len(gjs) == len(nat["rows"]) == len(pyo["rows"])
GATE_PY = re.compile(r"\b(import|from)\b")   # 파이썬 re의 \b는 유니코드 인식이라 JS와 다를 수 있다. 교차 확인용

def kind(r):
    return "None" if r is None else ("[]" if r == [] else f"list({len(r)})")

def klass(gate, r):
    if gate:
        return "gate 참·None(오탐)" if r is None else "gate 참·비None(참 양성 또는 [])"
    return "gate 거짓·None(건전)" if r is None else "gate 거짓·비None(예외)"

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
    return [line for line, r in out.items() if r[f"class_{env}"] == cls]
classes = ["gate 거짓·None(건전)", "gate 거짓·비None(예외)", "gate 참·None(오탐)", "gate 참·비None(참 양성 또는 [])"]
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
