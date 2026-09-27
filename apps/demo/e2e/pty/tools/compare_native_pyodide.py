"""native_result.json + pyodide_result.json + lines_B.json -> native_vs_pyodide.json(+ .meta.json).
사용: python3 compare_native_pyodide.py --dir <작업 폴더>
작업 폴더에 lines_B.json·native_result.json·pyodide_result.json이 있어야 하고, native_vs_pyodide.json(+ .meta.json)을 같은 폴더에 쓴다.
순수 JSON 조립이라 어느 파이썬으로 돌려도 같다.
차이 분류 규칙(위에서부터 처음 맞는 것):
  env        차이 항목이 전부 환경 전용 최상위 모듈(import 빈 스템·import _ 줄에서 도출한 네이티브 전용/pyodide 전용 집합)이거나 그 서브모듈이다.
  zip stdlib 네이티브에만 있고, 항목이 전부 HARDCODED_SUBMODULES 확장(collections.abc, os.path, xml.parsers.expat.errors|model)이다.
             (_is_stdlib_module이 FileFinder만 stdlib로 인정해서 zipimporter인 pyodide에서 빠진다)
  기타       위 둘로 설명되지 않는 것(파서 결과 parse가 다른 경우 포함).
"""
import argparse
import json
import os

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("--dir", required=True, help="작업 폴더(입력 3개를 읽고 결과 2개를 쓴다)")
here = os.path.abspath(ap.parse_args().dir)
lines = json.load(open(os.path.join(here, "lines_B.json")))
nat = json.load(open(os.path.join(here, "native_result.json")))
pyo = json.load(open(os.path.join(here, "pyodide_result.json")))
assert len(lines) == len(nat["rows"]) == len(pyo["rows"])

HARDCODED = {"collections": ["abc"], "os": ["path"], "xml.parsers.expat": ["errors", "model"]}
zip_items = set()
for path, subs in HARDCODED.items():
    for sub in subs:
        zip_items |= {sub, f"{path}.{sub}"}

by_line = {m["line"]: (m, n, p) for m, n, p in zip(lines, nat["rows"], pyo["rows"])}
def top(line):
    return set(by_line[line][1]["result"] or []), set(by_line[line][2]["result"] or [])
n_top = top("import ")[0] | top("import _")[0]
p_top = top("import ")[1] | top("import _")[1]
env_native_only = sorted(n_top - p_top)
env_pyodide_only = sorted(p_top - n_top)
env_names = set(env_native_only) | set(env_pyodide_only)

def is_env(item):
    return item in env_names or item.split(".")[0] in env_names

def kind(r):
    return "None" if r is None else ("[]" if r == [] else f"list({len(r)})")

out = {}
counts = {"same": 0, "diff": 0, "env": 0, "zip stdlib": 0, "기타": 0, "parse 불일치": 0, "순서만 다름": 0}
for m, n, p in zip(lines, nat["rows"], pyo["rows"]):
    a, b = n["result"], p["result"]
    row = {"id": m["id"], "origin": m["origin"], "note": m["note"],
           "native": a, "pyodide": b,
           "native_kind": kind(a), "pyodide_kind": kind(b),
           "parse_native": n["parse"], "parse_pyodide": p["parse"]}
    if n["parse"] != p["parse"]:
        counts["parse 불일치"] += 1
    if a == b:
        row["same"] = True
        row["diff"] = None
        counts["same"] += 1
    else:
        row["same"] = False
        na, pb = set(a or []), set(b or [])
        nonly, ponly = sorted(na - pb), sorted(pb - na)
        order_only = (na == pb and a != b)
        if order_only:
            counts["순서만 다름"] += 1
        if (a is None) != (b is None):
            cls = "기타"   # None <-> 목록/[]는 판정 자체가 다르다
        elif nonly + ponly and all(is_env(x) for x in nonly + ponly):
            cls = "env"
        elif nonly and not ponly and all(x in zip_items for x in nonly):
            cls = "zip stdlib"
        else:
            cls = "기타"
        counts[cls] += 1
        counts["diff"] += 1
        row["diff"] = {"class": cls, "native_only": nonly, "pyodide_only": ponly, "order_only": order_only}
    assert m["line"] not in out
    out[m["line"]] = row
json.dump(out, open(os.path.join(here, "native_vs_pyodide.json"), "w"), ensure_ascii=False, indent=1)
# 출처별(A 텍스트 / DELTA 추가 패턴 / 기대값 확인 / 보강) 동일·차이 수: 사전 조사 65케이스와 비교할 때 DELTA가 명시한 줄만 따로 본다
import re
counts_by_origin = {}
for r in out.values():
    key = "A(측정 A 텍스트)" if re.fullmatch(r"A\d+", r["origin"]) else r["origin"]
    c = counts_by_origin.setdefault(key, {"cases": 0, "same": 0, "diff": 0, "env": 0, "zip stdlib": 0, "기타": 0})
    c["cases"] += 1
    if r["same"]:
        c["same"] += 1
    else:
        c["diff"] += 1
        c[r["diff"]["class"]] += 1
meta = {
    "native": {"python": nat["python"], "cwd": nat["cwd"], "stdlib_path": nat["stdlib_path"], "sys_path": nat["sys_path"],
               "sys_modules_added": nat["sys_modules_added"], "sys_modules_removed": nat["sys_modules_removed"]},
    "pyodide": {"version": pyo["pyodide_version"], "python": pyo["python"], "cwd": pyo["cwd"], "stdlib_path": pyo["stdlib_path"],
                "sys_path": pyo["sys_path"], "sys_modules_added": pyo["sys_modules_added"], "sys_modules_removed": pyo["sys_modules_removed"]},
    "cases": len(out),
    "counts": counts,
    "counts_by_origin": counts_by_origin,
    "env_native_only_top_level": env_native_only,
    "env_pyodide_only_top_level": env_pyodide_only,
    "result_pkgnone_differs_native": [m["line"] for m, n in zip(lines, nat["rows"]) if n["result_pkgnone_differs"]],
    "result_pkgnone_differs_pyodide": [m["line"] for m, p in zip(lines, pyo["rows"]) if p["result_pkgnone_differs"]],
    "note": "result는 null=None(폴백), []=무동작, 목록=후보. 분류 규칙은 compare_native_pyodide.py 상단 주석.",
}
json.dump(meta, open(os.path.join(here, "native_vs_pyodide.meta.json"), "w"), ensure_ascii=False, indent=1)
print(json.dumps(counts, ensure_ascii=False))
print("env native-only:", env_native_only)
print("env pyodide-only:", env_pyodide_only)
for line, r in out.items():
    if not r["same"]:
        d = r["diff"]
        print(f"{r['id']} {d['class']:10} {line!r}  N={len(d['native_only'])} P={len(d['pyodide_only'])}")
