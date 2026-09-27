# 네이티브 python3.14와 pyodide가 같은 소스로 실행하는 프로브. probe(lines_json) -> JSON 문자열.
# 줄마다 ModuleCompleter().get_completions(line)(호출마다 새 인스턴스, Q6)과 ImportParser(line).parse() 결과를 기록한다.
# result: null = None(ModuleCompleter가 판정 없음 -> 폴백), [] = 무동작, 목록 = 후보.
import json
import sys

from _pyrepl._module_completer import ImportParser, ModuleCompleter


def probe(lines_json):
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
        # pty의 실제 REPL은 make_default_module_completer() = namespace {'__package__': None}를 쓴다
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
