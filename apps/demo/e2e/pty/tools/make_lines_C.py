"""측정 C 입력 줄 목록 `lines_C.json`을 만든다(RD-016).

사용: python3 make_lines_C.py --dir <출력 폴더>
- 입력: 없다. 코퍼스는 이 파일의 `build()`에 들어 있다.
- 출력: `<출력 폴더>/lines_C.json`. 줄 수를 stdout에 낸다.
- 순수 데이터 조립이라 어느 파이썬으로 돌려도 같다(pty·pyte 불필요).
- 게이트: 커서 앞 텍스트(+pending)에 `/\\b(import|from)\\b/`가 있는가.
- `tag`는 사람이 붙인 의도다. 실제 판정은 build_gate_corpus.py가 실측으로 한다.
- 파이프라인 위치는 pty/tools/README.md "의존 관계(rd-016)"다.
"""
import argparse
import json
import os


def build():
    """코퍼스 줄 목록을 만든다. 항목은 `{line, tag, note, id}`(`id`는 `C01`부터)다.

    태그 셋:
    - `gate-false 예상`: 게이트가 거짓이어야 한다. 네이티브가 전부 None이어야 게이트가 건전하다.
    - `gate-true 오탐 예상`: 게이트가 참이지만 None이어야 한다. 오탐은 왕복만 늘고 동작은 같다.
    - `gate-true 참 양성 대조`: 게이트가 참이고 후보가 나온다. 대조군이다.

    같은 줄이 두 번 나오면 AssertionError다.
    """
    rows = []

    def add(line, tag, note=""):
        rows.append({"line": line, "tag": tag, "note": note})

    # --- 게이트가 거짓일 것으로 예상하는 줄
    for line, note in [
        ("x = 1", ""), ("os.pa", ""), ("print(", ""), ("__import__('os')", ""), ("important.x", ""),
        ("imports.pa", ""), ("reimport", ""), ("", "빈 줄"), ("   ", "공백만"), ("\t", "탭만"),
        ("def f():", ""), ("    return x", ""), ("fromage.x", "from으로 시작하는 식별자"), ("from_ = 1", "from_ 식별자"),
        ("print(from_)", "from_ 식별자"), ("_import", ""), ("import_x", ""), ("x.imported", ""),
        ("os.path.join(a, b)", ""), ("for x in range(3):", ""), ("x = [i for i in y]", ""),
        ("x = 1\ny = 2", "다중 줄, 토큰 없음"), ("def f():\n    return", "다중 줄, 토큰 없음"),
        ("1import os", "적대: 숫자 리터럴 바로 뒤 import(JS \\b 경계 없음)"),
        ("1from os", "적대: 숫자 리터럴 바로 뒤 from"),
        ("1jimport os", "적대: 허수 리터럴 뒤"),
        ("1.5from os", "적대: 실수 리터럴 뒤"),
        ("0x1fimport os", "적대: 16진 리터럴 뒤"),
        ("ｉmport os", "적대: 전각 i(NFKC로는 import)"),
        ("def f(from_=1): pass", "from_ 식별자"),
    ]:
        add(line, "gate-false 예상", note)

    # --- 게이트가 참이지만 None일 것으로 예상하는 줄
    for line, note in [
        ('x = "import os"', "문자열 안"), ("# from", "주석"), ("# import os", "주석"), ('"from a"', "문자열"),
        ("print('import')", "문자열"), ("x = 'from os import path'", "문자열"), ("foo.import", "속성 자리 import"),
        ("print(from", "키워드 뒤 괄호 안"), ("import", "공백 없음"), ("from", "공백 없음"),
        ("x = 1  # import", "주석"), ("yield from", "공백 없음"), ("raise X from", "공백 없음"),
        ("이import os", "JS \\b는 참, 파이썬 토크나이저는 한 식별자"), ("import이 os", "JS \\b는 참, 파이썬 토크나이저는 한 식별자"),
    ]:
        add(line, "gate-true 오탐 예상", note)

    # --- 게이트가 참이고 후보가 나오는 줄
    for line, note in [
        ("import os.pa", ""), ("from os import pa", ""), ("x = 1; import o", ""), ("x = 1\nimport o", ""),
        ("raise ValueError from o", "from 키워드 quirk"), ("import os  # c\n", "주석 뒤 빈 줄 quirk"),
        ("import os; os.pa", "None 예상(속성 완성 폴백)"), ("import os\nos.pa", "None 예상"),
    ]:
        add(line, "gate-true 참 양성 대조", note)

    # 줄 중복을 막고 순번 id를 붙인다.
    seen = set()
    for i, r in enumerate(rows):
        assert r["line"] not in seen, f"중복: {r['line']!r}"
        seen.add(r["line"])
        r["id"] = f"C{i+1:02d}"
    return rows


def main():
    """`lines_C.json`을 `--dir`에 쓴다(폴더가 없으면 만든다)."""
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dir", required=True, help="출력 폴더(lines_C.json)")
    args = ap.parse_args()
    rows = build()
    os.makedirs(args.dir, exist_ok=True)
    with open(os.path.join(args.dir, "lines_C.json"), "w") as f:
        json.dump(rows, f, ensure_ascii=False, indent=1)
    print(len(rows))


if __name__ == "__main__":
    main()
