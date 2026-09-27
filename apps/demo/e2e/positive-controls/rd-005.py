#!/usr/bin/env python3
"""양성 대조 드라이버. 소스를 변조 → 브라우저 확인 실행(해당 확인만 실패해야 함) → git checkout으로 원복 → 재실행(통과).
출처 RD-005, `_works/_completed/20260922-05-rd-005-repl-loop/verify/positive-controls.py`에서 이관(RD-018 DELTA-04).

사용: python3 rd-005.py <1|2|3|4>
  1: pyodide-terminal/src/prompt-row.ts read()의 io.sinks.resetTail() 삭제(RD-027, 구 terminal/repl-reader.ts) → prompt-join-check (W4·U1 등 꼬리 물려받음)
  2: worker/submission-runner.ts의 withoutTrailingNewline 제거 → repl-check normal + trailing-newline-check (오류 경로 빈 줄)
  3: worker/boot.ts의 rpc.notify("sessionTerminated") 삭제    → repl-check normal (⑦ 상태 terminated 시간 초과)
  4: worker/console.ts의 retrieveException(fut) 삭제(DELTA-01a) → carryover-check ((b) never retrieved 로그 누출)
dev 서버(5173)는 이 드라이버가 변조·원복 때마다 다시 띄운다(끝나면 dev 서버가 하나 남는다). 원복은 `git checkout -- <파일>`이고 대상 파일은 시작 전에 깨끗해야 한다.
깨끗한 트리에서만 실행해라(시작 전 `git status --short` 빈 출력을 확인).
"""
import os
import re
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
CHECKS = REPO / "apps" / "demo" / "e2e" / "checks"
URL = "http://localhost:5173/"
DEV_LOG = os.environ.get("DEV_LOG", os.path.join(tempfile.gettempdir(), "rd-005-positive-control-dev.log"))

CONTROLS = {
    "1": {
        # RD-027: repl-reader.ts가 삭제되고 REPL 읽기의 꼬리 리셋은 promptRow.read()로 옮겼다(stdin 읽기와 공유).
        "file": "packages/pyodide-terminal/src/prompt-row.ts",
        "find": "      io.sinks.resetTail();\n",
        "replace": "",
        # 확인을 분리해서 돌린다. 꼬리가 세션 내내 남는 결함이라 전체를 돌리면 U1 뒤 모든 확인이 연쇄로 실패한다.
        "scripts": [
            ["prompt-join-check.mjs", URL, {"ONLY": "T1,U1"}],
            ["prompt-join-check.mjs", URL, {"ONLY": "W4"}],
            ["prompt-join-check.mjs", URL],
        ],
    },
    "2": {
        "file": "packages/pyodide-repl/src/worker/submission-runner.ts",
        "find": "io.writeError(withoutTrailingNewline(result.formattedError));",
        "replace": "io.writeError(result.formattedError);",
        "scripts": [["repl-check.mjs", "normal", URL], ["trailing-newline-check.mjs", URL]],
    },
    "4": {
        # DELTA-01a 수정 제거: 문법 오류 future의 예외를 회수하지 않으면 GC 때 never retrieved 로그가 새어야 한다.
        "file": "packages/pyodide-repl/src/worker/console.ts",
        "find": "          retrieveException(fut);\n",
        "replace": "",
        "scripts": [["carryover-check.mjs", URL]],
    },
    "3": {
        "file": "packages/pyodide-repl/src/worker/repl-driver.ts",
        "find": 'onTerminated: () => rpc.notify("sessionTerminated"),',
        "replace": "onTerminated: () => {},",
        "scripts": [["repl-check.mjs", "normal", URL]],
    },
}


def sh(args, **kw):
    return subprocess.run(args, capture_output=True, text=True, **kw)


def dev_pid():
    m = re.search(r":5173\b.*?pid=(\d+)", sh(["ss", "-ltnp"]).stdout)
    return int(m.group(1)) if m else None


def restart_dev():
    """dev 서버를 다시 띄운다. `git checkout`이 파일을 새 inode로 바꾸면 Vite 감시가 그 파일을 놓쳐 낡은 모듈을 계속 주므로
    (TRP-007) 변조·원복 때마다 재시작해 최신 소스를 읽게 한다."""
    pid = dev_pid()
    if pid:
        os.kill(pid, signal.SIGTERM)
        for _ in range(50):
            if dev_pid() is None:
                break
            time.sleep(0.1)
    log = open(DEV_LOG, "a")
    subprocess.Popen(["pnpm", "exec", "vite", "--port", "5173", "--strictPort"], cwd=str(REPO / "apps" / "demo"), stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    for _ in range(100):
        if sh(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", URL]).stdout == "200":
            return
        time.sleep(0.2)
    sys.exit("dev 서버가 뜨지 않았다")


def run_scripts(scripts):
    """스크립트를 차례로 돌려 [(이름, PASS 수, FAIL 이름들)]를 돌려준다."""
    out = []
    for script in scripts:
        env = None
        if isinstance(script[-1], dict):
            env = {**os.environ, **script[-1]}
            script = script[:-1]
        r = sh(["node", str(CHECKS / script[0]), *script[1:]], cwd=str(CHECKS), timeout=400, env=env)
        fails = [re.sub(r"\s+—.*$", "", l[6:]) for l in r.stdout.splitlines() if l.startswith("FAIL")]
        passes = sum(1 for l in r.stdout.splitlines() if l.startswith("PASS"))
        detail = {re.sub(r"\s+—.*$", "", l[6:]): l for l in r.stdout.splitlines() if l.startswith("FAIL")}
        label = script[0] + (f" ONLY={env['ONLY']}" if env else "")
        out.append((label, passes, fails, detail))
    return out


def main(key):
    c = CONTROLS[key]
    path = REPO / c["file"]
    if sh(["git", "diff", "--quiet", "--", c["file"]], cwd=str(REPO)).returncode != 0:
        sys.exit(f"대상 파일이 깨끗하지 않다: {c['file']}")
    original = path.read_text(encoding="utf-8")
    if c["find"] not in original:
        sys.exit(f"find 문자열이 없다: {c['find']!r}")
    try:
        path.write_text(original.replace(c["find"], c["replace"], 1), encoding="utf-8")
        print(f"== 양성 대조 {key}: 변조 적용({c['file']})")
        restart_dev()
        mutated = run_scripts(c["scripts"])
    finally:
        sh(["git", "checkout", "--", c["file"]], cwd=str(REPO))
    restored_clean = sh(["git", "diff", "--quiet", "--", c["file"]], cwd=str(REPO)).returncode == 0
    print(f"원복(git checkout) 후 깨끗함: {restored_clean}")
    for name, passes, fails, detail in mutated:
        print(f"[변조] {name}: PASS {passes}, FAIL {len(fails)}")
        for f in fails:
            print(f"   FAIL {detail[f][6:260]}")
    print("== 원복 후 재실행")
    restart_dev()
    for name, passes, fails, _ in run_scripts(c["scripts"]):
        print(f"[원복] {name}: PASS {passes}, FAIL {len(fails)} {fails}")


main(sys.argv[1])
