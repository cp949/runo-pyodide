"""네이티브 CPython 3.14에서 `mc_probe.probe`를 돌려 `native_result*.json`을 만든다(RD-016 측정 B·C).

사용: python native_complete.py <입력 lines json> <출력 json> [--python P] [--allow-version-mismatch]
- 입력: `lines_B.json` 또는 `lines_C.json`.
- 출력: `native_result.json`(B) 또는 `native_result_C.json`(C).
- 두 이름은 위치 인자로 준다.
- 대상 인터프리터는 `ptyrepl`과 같은 규칙으로 정한다: `--python` > `PTY_PYTHON` > `PATH`의 `python3.14`.
  버전·venv·pyte 게이트도 `ptyrepl`과 같다(규칙은 pty/tools/README.md "인자 규칙").
- 이 스크립트를 돌리는 파이썬(하니스 venv 등)과 무관하게 프로브는 대상 인터프리터를 자식 프로세스로 띄워 실행한다.

REPL과 같은 조건으로 프로브한다.
- `sys.path[0] == ''`. 자식을 `-c`로 시작하므로 스크립트 폴더가 아니라 `''`가 된다.
  이전 구현은 스크립트 실행 뒤 `sys.path[0]`을 `''`로 바꿨다.
- cwd는 빈 임시 폴더다. cwd 파일이 후보에 섞이지 않게 한다(TRAP-27).
"""
import argparse
import os
import subprocess
import sys

import ptyrepl

HERE = os.path.dirname(os.path.abspath(__file__))

# 자식 인터프리터에서 `-c`로 실행할 코드.
# 인자: `mc_probe.py` 경로, 입력 lines json, 출력 json.
# import 집합(json·os·sys·tempfile)은 이전 구현과 같게 유지한다.
# `probe()`가 `sys.modules` 전후를 비교하므로 사전 로드 모듈이 바뀌면 `sys_modules_added` 기록이 달라질 수 있다.
_CHILD = r"""
import json
import os
import sys
import tempfile

probe_py, inp, outp = sys.argv[1:4]
lines = [r["line"] for r in json.load(open(inp))]
src = open(probe_py).read()
assert sys.path[0] == "", sys.path[0]
os.chdir(tempfile.mkdtemp())
ns = {}
exec(compile(src, "mc_probe.py", "exec"), ns)
out = json.loads(ns["probe"](json.dumps(lines)))
json.dump(out, open(outp, "w"), ensure_ascii=False, indent=1)
print(out["python"].split()[0], "cwd =", out["cwd"], "rows =", len(out["rows"]), "sys.modules 추가 =", out["sys_modules_added"])
"""


def main(argv=None):
    """인자를 해석하고 대상 인터프리터를 확정해 프로브 자식을 실행한다. 자식의 종료 코드를 돌려준다.

    인터프리터 해석·게이트에 실패하면 `ptyrepl.setup_from_args`가 종료 코드 2로 끝낸다.
    """
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("lines", help="입력 lines json(make_lines_B/C 출력)")
    ap.add_argument("out", help="출력 json(native_result.json / native_result_C.json)")
    ptyrepl.add_interpreter_args(ap)
    args = ap.parse_args(argv)
    interp = ptyrepl.setup_from_args(args)
    print(f"인터프리터({interp.source}): {interp.path}\n버전: {interp.version}", flush=True)
    outp = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(outp), exist_ok=True)
    # 자식 환경: 현재 환경에서 파이썬 동작을 바꾸는 변수만 뺀다.
    # venv·PYTHONPATH가 후보 집합을 오염시키지 않게 한다.
    env = {k: v for k, v in os.environ.items() if k not in ("VIRTUAL_ENV", "PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP")}
    cp = subprocess.run(
        [interp.path, "-c", _CHILD, os.path.join(HERE, "mc_probe.py"), os.path.abspath(args.lines), outp],
        env=env,
    )
    return cp.returncode


if __name__ == "__main__":
    sys.exit(main())
