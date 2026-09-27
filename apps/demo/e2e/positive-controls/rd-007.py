#!/usr/bin/env python3
"""양성 대조 드라이버. 소스를 변조 → 브라우저 확인 실행(해당 확인만 실패해야 함) → git checkout으로 원복 → 재실행(통과).
출처 RD-007, `_works/_completed/20260922-07-rd-007-ctrl-c-running/verify/positive-controls.py`에서 이관(RD-018 DELTA-04).

사용: python3 rd-007.py <1|2|3>
  1: index.ts의 sinks.write("^C") → readline.print("^C")          → ctrl-c-check ONLY=S1 실패(꼬리에 안 남아 `t^Cx: abc`가 아님), ONLY=G1은 통과(대조)
  2: protocol/interrupt-sender.ts의 재전송(compareExchange) 삭제   → press-loss N에서 HANG > 0("0이 아님"만 판정)
  3: worker/sigint-handler.ts의 `<console>` 프레임 규칙 제거(항상 raise) → burst-matrix COMBOS=a에서 DIRTY/CRASH > 0
dev 서버(5173)는 이 드라이버가 변조·원복 때마다 다시 띄운다(끝나면 dev 서버가 하나 남는다, TRP-007). 원복은 `git checkout -- <파일>`이고 대상 파일은
시작 전에 깨끗해야 한다(아니면 중단). 깨끗한 트리에서만 실행해라(시작 전 `git status --short` 빈 출력을 확인).

경로 참고(RD-018 이관): ctrl-c-check.mjs는 apps/demo/e2e/checks/, press-loss.mjs·burst-matrix.mjs는
apps/demo/e2e/measure/에 있다(계획서의 "대조 대상이 sleep-await-check.mjs인 경우 measure/로"와 같은 규칙을
이 파일의 press-loss·burst-matrix에도 적용했다 — 둘 다 measure 스크립트이기 때문, DELTA-04 "## 결정" 참고).
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
E2E = REPO / "apps" / "demo" / "e2e"
URL = "http://localhost:5173/"
DEV_LOG = os.environ.get("DEV_LOG", os.path.join(tempfile.gettempdir(), "rd-007-positive-control-dev.log"))

CONTROLS = {
    "1": {
        # RD-018 DELTA-04 경로 정정(멈추는 지점 3): `sinks.write("^C")`는 RD-010의 세션 추출로 index.ts에서
        # session.ts의 echoCtrlC()로 옮겨졌다(문자열·들여쓰기는 그대로, 파일만 다르다). readline은 startSession의
        # 인자로 session.ts 스코프에도 있어 같은 변조가 그대로 적용된다.
        # RD-020 DELTA-04 경로 정정: session.ts를 core 세션과 REPL main driver로 나누면서 echoCtrlC()가
        # `repl-main-driver.ts`로 갔다(문자열·들여쓰기 그대로, readline은 `createReplMainDriver`의 옵션으로 스코프에 있다).
        "file": "packages/pyodide-repl/src/repl-main-driver.ts",
        "find": '      sinks.write("^C");',
        "replace": '      readline.print("^C");',
        # S1만 `^C`의 위치를 본다. G1(트레이스백)은 에코 방식과 무관하므로 통과해야 한다 — "해당 확인만 실패한다"는 대조.
        "scripts": [
            ["checks/ctrl-c-check.mjs", URL, {"ONLY": "S1"}],
            ["checks/ctrl-c-check.mjs", URL, {"ONLY": "G1"}],
        ],
    },
    "2": {
        "file": "packages/pyodide-core/src/protocol/interrupt-sender.ts",
        "find": "      Atomics.compareExchange(buffer, SIGNAL, 0, 2);\n      resends++;\n",
        "replace": "",
        # 소실은 확률적이다. 기본 200회로 보고 0이면 호출자가 N을 올려 한 번 더 돌린다.
        "scripts": [["measure/press-loss.mjs", URL, {"N": os.environ.get("N", "200")}]],
    },
    "3": {
        # RD-018 DELTA-04 경로 정정(멈추는 지점 3): 이 판정 로직은 DELTA-00 무렵 `sigint-handler.ts`에서
        # `sigint-handler.py`(Python 소스, `?raw` import)로 옮겨졌다 — ts는 이제 그 소스를 심는 JS 래퍼만
        # 남았다. find·replace 문자열·들여쓰기는 그대로(같은 한 줄), 파일만 다르다.
        "file": "packages/pyodide-core/src/worker/sigint-handler.py",
        "find": "            if f.f_code.co_filename == user_filename:",
        "replace": "            if True:",
        "scripts": [["measure/burst-matrix.mjs", URL, {"COMBOS": "a", "N": "20"}]],
    },
}


def sh(args, **kw):
    return subprocess.run(args, capture_output=True, text=True, **kw)


def dev_pid():
    m = re.search(r":5173\b.*?pid=(\d+)", sh(["ss", "-ltnp"]).stdout)
    return int(m.group(1)) if m else None


def restart_dev():
    """dev 서버를 다시 띄운다. `git checkout`이 파일을 새 inode로 바꾸면 Vite 감시가 그 파일을 놓쳐 낡은 모듈을 계속 주므로(TRP-007)
    변조·원복 때마다 재시작해 최신 소스를 읽게 한다."""
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
    """스크립트를 차례로 돌려 [(이름, PASS 수, FAIL 이름들, 상세, 끝 요약)]를 돌려준다."""
    out = []
    for script in scripts:
        env = None
        if isinstance(script[-1], dict):
            env = {**os.environ, **script[-1]}
            script = script[:-1]
        r = sh(["node", str(E2E / script[0]), *script[1:]], cwd=str(E2E), timeout=1800, env=env)
        lines = r.stdout.splitlines()
        fails = [re.sub(r"\s+—.*$", "", l[6:]) for l in lines if l.startswith("FAIL")]
        passes = sum(1 for l in lines if l.startswith("PASS"))
        detail = {re.sub(r"\s+—.*$", "", l[6:]): l for l in lines if l.startswith("FAIL")}
        label = script[0] + (f" {','.join(f'{k}={v}' for k, v in env.items() if k in ('ONLY', 'COMBOS', 'N'))}" if env else "")
        # 판정이 PASS/FAIL 줄이 아닌 스크립트(press-loss·burst-matrix)는 종료 코드와 요약 JSON으로 본다.
        summary = "\n".join(lines[-40:]) if not lines or passes + len(fails) == 0 else ""
        out.append((label, passes, fails, detail, r.returncode, summary))
    return out


def report(tag, results):
    for name, passes, fails, detail, code, summary in results:
        print(f"[{tag}] {name}: PASS {passes}, FAIL {len(fails)} {fails} exit={code}")
        for f in fails:
            print(f"   FAIL {detail[f][6:300]}")
        if summary:
            print(f"   요약: {summary[-1200:]}")


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
        print(f"== 양성 대조 {key}: 변조 적용({c['file']})", flush=True)
        restart_dev()
        mutated = run_scripts(c["scripts"])
    finally:
        sh(["git", "checkout", "--", c["file"]], cwd=str(REPO))
    restored_clean = sh(["git", "diff", "--quiet", "--", c["file"]], cwd=str(REPO)).returncode == 0
    print(f"원복(git checkout) 후 깨끗함: {restored_clean}")
    report("변조", mutated)
    print("== 원복 후 재실행", flush=True)
    restart_dev()
    report("원복", run_scripts(c["scripts"]))


main(sys.argv[1])
