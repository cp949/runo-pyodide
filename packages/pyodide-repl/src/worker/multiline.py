# 개행이 든 제출 문자열을 top-level 문장 단위 chunk로 나누는 분할기(RD-011, 02-console-core.md 5.2).
import ast
import os
import traceback
import warnings

from pyodide.ffi import to_js

# ast.PyCF_ALLOW_TOP_LEVEL_AWAIT와 같은 값. worker/top-level-await.ts의 TOP_LEVEL_AWAIT_FLAG와 동기화.
TOP_LEVEL_AWAIT_FLAG = 0x2000


def _dedent(source):
    """비어 있지 않은 모든 줄이 공통 들여쓰기를 가질 때만 그만큼 제거한다.

    textwrap.dedent는 공백만 있는 줄을 항상 빈 줄로 바꿔서, 들여쓰기가 없는 입력에서도
    여러 줄 문자열 안의 공백 줄 내용이 달라지므로 쓰지 않는다.
    """
    lines = source.split("\n")
    margin = None
    for line in lines:
        if not line.strip():
            continue
        indent = line[: len(line) - len(line.lstrip(" \t"))]
        margin = indent if margin is None else os.path.commonprefix([margin, indent])
    if not margin:
        return source
    return "\n".join(line[len(margin) :] if line.startswith(margin) else line for line in lines)


def _parse(source, flags):
    # TLA가 켜진 플래그로는 ast.parse가 임의 플래그를 받지 않으므로 PyCF_ONLY_AST로 컴파일해 AST를 얻는다
    # (그래야 top-level await가 파싱 단계에서 SyntaxError가 되지 않는다).
    if flags & TOP_LEVEL_AWAIT_FLAG:
        return compile(source, "<console>", "exec", flags | ast.PyCF_ONLY_AST, True)
    return ast.parse(source, "<console>")


def split_paste(source, flags):
    source = _dedent(source.replace("\r\n", "\n").replace("\r", "\n"))
    try:
        with warnings.catch_warnings():
            # 같은 경고가 실제 실행(push) 시점에 다시 나오므로 분할 중에는 숨긴다.
            warnings.simplefilter("ignore")
            tree = _parse(source, flags)
            # 파싱만으로는 잡히지 않는 오류(함수 밖 return 등, RD-011 확정 12)를 여기서 확인한다.
            compile(tree, "<console>", "exec", flags, True)
    except (SyntaxError, ValueError, OverflowError) as error:
        # 파싱·컴파일 단계 오류가 하나라도 있으면 아무 문장도 실행하지 않는다(CPython 3.14 REPL과 동일).
        return to_js(["".join(traceback.format_exception_only(error)), []], depth=3)
    lines = source.split("\n")
    spans = []
    for stmt in tree.body:
        # 데코레이터는 stmt.lineno보다 앞 줄에 있으므로 chunk 시작 줄에 포함한다.
        first = min([stmt.lineno, *(d.lineno for d in getattr(stmt, "decorator_list", []))])
        if spans and first <= spans[-1][1]:
            # `a = 1; b = 2`처럼 한 줄을 공유하는 문장은 줄이 중복되지 않게 chunk 하나로 묶는다.
            spans[-1][1] = max(spans[-1][1], stmt.end_lineno)
        else:
            spans.append([first, stmt.end_lineno])
    # 여러 줄 문자열 리터럴 안쪽 줄은 빈 줄이어도 내용의 일부이므로 chunk에서 빼지 않는다.
    # f-string/t-string의 리터럴 조각도 ast.Constant라 함께 걸린다.
    literal_lines = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant):
            literal_lines.update(range(node.lineno + 1, node.end_lineno))
    chunks = [
        [
            line
            for number, line in enumerate(lines[first - 1 : last], first)
            if line.strip() or number in literal_lines
        ]
        for first, last in spans
    ]
    return to_js([None, chunks], depth=3)
