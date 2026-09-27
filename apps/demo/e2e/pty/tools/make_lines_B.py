"""측정 B 입력 줄 목록(lines_B.json)을 만든다: A 케이스의 커서까지 텍스트 + DELTA 추가 패턴 + 기대값 확인용 + 보강.
사용: python3 make_lines_B.py --dir <출력 폴더> [--cases <cases_import.json>]
- 입력 기본값은 저장소 기준 데이터 apps/demo/e2e/pty/rd-016/cases_import.json(읽기 전용).
- 순수 데이터 조립이라 어느 파이썬으로 돌려도 같다(pty·pyte 불필요).
"""
import argparse
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CASES = os.path.normpath(os.path.join(HERE, "..", "rd-016", "cases_import.json"))


def build(cfg):
    rows = []

    def add(line, origin, note=""):
        rows.append({"line": line, "origin": origin, "note": note})

    # 1) A 케이스: 커서까지 텍스트 = 입력 전체(커서는 항상 끝)
    for c in cfg["import"]:
        add(c["text"], c["id"], c["group"])

    # 2) DELTA-01.md 측정 B의 추가 패턴
    for line, note in [
        ("import _", ""),
        ("import os.", ""),
        ("import xml.", ""),
        ("import xml.dom.", ""),
        ("from xml import d", ""),
        ("from email import ", ""),
        ("from xml.parsers.expat import ", ""),
        ("import xml.parsers.expat.", ""),
        ("import concurrent.f", ""),
        ("import importlib.m", ""),
        ("from os import (", ""),
        ("import os.path.", ""),
        ("import  ", "import 뒤 공백 2개"),
        ("import os\n", "여러 줄: 줄바꿈 뒤 커서"),
        ("from os import (\n", "여러 줄: 줄바꿈 뒤 커서"),
        ("x = 1\nimport o\n", "여러 줄: 줄바꿈 뒤 커서"),
    ]:
        add(line, "추가 패턴", note)

    # 3) 기대값 절에 나오지만 A에 없는 줄
    for line in ["import os.p", "from os.p", "from .. import ", "from sys import ", "import os as x", "from os import p"]:
        add(line, "기대값 확인")

    # 4) 보강: 파서 분기(콤마·as·괄호·공백·토큰 오류)와 환경 차이 진단
    for line, note in [
        ("import os,", "후행 콤마"),
        ("import os, ", "콤마+공백"),
        ("import os as", ""),
        ("import os as ", ""),
        ("from os import path as", ""),
        ("from os import path,", ""),
        ("from os import path, ", ""),
        ("from os import (path,", ""),
        ("from xml.dom import minidom, m", ""),
        ("import a.b as c, os.p", ""),
        ("from  os  import  pa", "공백 2개씩"),
        ("\timport os.p", "선행 탭"),
        ("import os.pa\"", "닫히지 않은 문자열: 토큰 오류"),
        ("import (", ""),
        ("import", "공백 없음"),
        ("from", "공백 없음"),
        ("from . import", "공백 없음"),
        ("import 한", "비 ASCII 식별자"),
        ("import os.pa  # c", "주석 뒤(스템은 c)"),
        ("import os.pa\n", "줄바꿈 뒤 커서"),
        ("if True:\n    from os import p", ""),
        ("class A:\n    import o", ""),
        ("from importlib import m", ""),
        ("from concurrent import f", ""),
        ("import concurrent.futures.t", ""),
        ("import importlib.metadata.", ""),
        ("import unittest.m", ""),
        ("import json.t", ""),
        ("from __future__ import a", "모듈(비 패키지)"),
        ("import sys.", "빌트인"),
        ("import tkinter.", "환경 차이 진단(pyodide에 없음)"),
        ("import pyodide.", "환경 차이 진단(pyodide 전용)"),
        ("import c", "환경 차이 진단"),
        ("import p", "환경 차이 진단"),
        ("import t", "환경 차이 진단"),
        ("import s", "환경 차이 진단"),
    ]:
        add(line, "보강", note)

    seen = set()
    for i, r in enumerate(rows):
        assert r["line"] not in seen, f"중복 줄: {r['line']!r}"
        seen.add(r["line"])
        r["id"] = f"B{i+1:03d}"
    return rows


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cases", default=DEFAULT_CASES, help=f"케이스 정의 JSON(기본: {DEFAULT_CASES})")
    ap.add_argument("--dir", required=True, help="출력 폴더(lines_B.json)")
    args = ap.parse_args()
    rows = build(json.load(open(args.cases)))
    os.makedirs(args.dir, exist_ok=True)
    with open(os.path.join(args.dir, "lines_B.json"), "w") as f:
        json.dump(rows, f, ensure_ascii=False, indent=1)
    print(len(rows))


if __name__ == "__main__":
    main()
