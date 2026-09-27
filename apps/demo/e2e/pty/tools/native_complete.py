"""대상 인터프리터(네이티브 CPython 3.14)에서 mc_probe.probe를 lines json에 돌려 native_result*.json을 만든다.
REPL과 같은 조건: sys.path[0] == ''(스크립트 폴더가 아님) + 빈 임시 cwd(cwd 파일이 후보에 섞이지 않게).

사용: python native_complete.py <입력 lines json> <출력 json> [--python P] [--allow-version-mismatch]
- 대상 인터프리터는 ptyrepl과 같은 3단 규칙(--python > PTY_PYTHON > PATH의 python3.14)과 버전·venv·pyte 게이트로 정한다.
- 이 스크립트를 돌리는 파이썬(하니스 venv 등)과 무관하게, 프로브는 대상 인터프리터를 자식 프로세스로 띄워 실행한다.
  자식은 `-c`로 시작하므로 sys.path[0]이 ''이다(원본은 스크립트 실행 뒤 sys.path[0]을 ''로 바꿨다).
"""
import argparse
import os
import subprocess
import sys

import ptyrepl

HERE = os.path.dirname(os.path.abspath(__file__))

# 자식에서 실행할 코드. import 집합(json·os·sys·tempfile)은 원본과 같게 유지한다:
# probe()가 sys.modules 전후를 비교하므로 사전 로드 모듈이 바뀌면 sys_modules_added 기록이 달라질 수 있다.
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
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("lines", help="입력 lines json(make_lines_B/C 출력)")
    ap.add_argument("out", help="출력 json(native_result.json / native_result_C.json)")
    ptyrepl.add_interpreter_args(ap)
    args = ap.parse_args(argv)
    interp = ptyrepl.setup_from_args(args)
    print(f"인터프리터({interp.source}): {interp.path}\n버전: {interp.version}", flush=True)
    outp = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(outp), exist_ok=True)
    # 자식 환경: 현재 환경에서 파이썬 동작을 바꾸는 변수만 뺀다(venv·PYTHONPATH가 후보 집합을 오염시키지 않게)
    env = {k: v for k, v in os.environ.items() if k not in ("VIRTUAL_ENV", "PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP")}
    cp = subprocess.run(
        [interp.path, "-c", _CHILD, os.path.join(HERE, "mc_probe.py"), os.path.abspath(args.lines), outp],
        env=env,
    )
    return cp.returncode


if __name__ == "__main__":
    sys.exit(main())
