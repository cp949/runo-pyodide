# 네이티브 python3.14와 pyodide가 같은 소스로 실행하는 프로브(RD-016 측정 B·C).
# 호출: `probe(lines_json)`. 입력은 줄 목록의 JSON 문자열이고 반환은 결과 JSON 문자열이다.
# 실행하는 쪽: native_complete.py(자식 인터프리터에서 exec), pyodide_complete.mjs(pyodide에서 실행).
#
# 줄마다 기록하는 값:
# - `parse`: `ImportParser(line).parse()` 결과.
# - `result`: `ModuleCompleter().get_completions(line)` 결과. 호출마다 새 인스턴스를 만든다.
#   - `null`: None. ModuleCompleter가 판정하지 않는다(폴백).
#   - `[]`: 무동작.
#   - 목록: 후보.
# - `result_pkgnone_differs`: namespace를 달리한 인스턴스의 결과가 `result`와 다른가.
import json
import sys

from _pyrepl._module_completer import ImportParser, ModuleCompleter


def probe(lines_json):
    """줄 목록(JSON 문자열)을 프로브해 결과 JSON 문자열을 돌려준다.

    반환 필드: `python`·`stdlib_path`·`cwd`·`sys_path`, 실행 전후 `sys.modules` 차이, 줄별 `rows`.
    `sys.modules` 차이는 프로브가 모듈을 로드하지 않는지 확인하는 값이다.
    """
    lines = json.loads(lines_json)
    before = set(sys.modules)
    rows = []
    for line in lines:
        try:
            parsed = ImportParser(line).parse()
            parse = None if parsed is None else list(parsed)
        except Exception as e:  # ImportParser는 던지지 않아야 한다. 던지면 기록한다
            parse = "EXC:" + repr(e)
        result = ModuleCompleter().get_completions(line)
        # pty의 실제 REPL은 make_default_module_completer() = namespace {'__package__': None}를 쓴다.
        # 기본 인스턴스와 결과가 같은지 교차 확인한다.
        result_pkgnone = ModuleCompleter(namespace={"__package__": None}).get_completions(line)
        rows.append({
            "line": line,
            "parse": parse,
            "result": result,
            "result_pkgnone_differs": result_pkgnone != result,
        })
    after = set(sys.modules)
    return json.dumps({
        "python": sys.version,
        "stdlib_path": ModuleCompleter()._stdlib_path,
        "cwd": __import__("os").getcwd(),
        "sys_path": sys.path,
        "sys_modules_added": sorted(after - before),
        "sys_modules_removed": sorted(before - after),
        "rows": rows,
    }, ensure_ascii=False)
