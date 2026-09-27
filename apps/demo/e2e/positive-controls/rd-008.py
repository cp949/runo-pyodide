#!/usr/bin/env python3
"""양성 대조 드라이버. 소스를 변조 → 브라우저 확인 실행(지정한 확인만 실패해야 함) → `git checkout`으로 원복 → 재실행(통과).
출처 RD-008, `_works/_completed/20260922-08-rd-008-prompt-and-input-cancel/verify/positive-controls.py`에서
이관(RD-018 DELTA-04).

사용: python3 rd-008.py <1|2|3>
  1: worker/stdin-callback.ts의 `deps.checkInterrupt();` 삭제
       → input-cancel-check ONLY=RM2 실패(`EOFError` 트레이스백), ONLY=E1(정상 input())은 통과
  2: worker/boot.ts의 `signalInterrupt` 주입이 요청 번호를 올리지 않음
       → input-cancel-check ONLY=T35·ONLY=RM2 둘 다 실패(시간 초과 — 핸들러가 설치 시점 번호 0을
         last_seq로 잡아 번호를 올리지 않는 전송은 세션 첫 취소부터 재전송으로 오인, CPython이 읽기를
         재시도해 프롬프트로 안 돌아온다). 이 대조는 검출력 증명만 하고 국소성 증명은 #1·#3이 맡는다.
         T35는 '번호가 0→1 이후에도 전진해야 한다'를 고정하려 남긴다.
  3: index.ts 게이트에서 `&& !cancelSettling` 삭제
       → prompt-cancel-check ONLY=I 실패(취소 직후 연타가 `^C`를 에코한다), ONLY=RM1은 통과
dev 서버(5173)는 이 드라이버가 변조·원복 때마다 다시 띄운다(끝나면 dev 서버가 하나 남는다, TRP-007).
원복은 `git checkout -- <파일>`이고 대상 파일은 시작 전에 깨끗해야 한다(아니면 중단). 깨끗한 트리에서만 실행해라
(시작 전 `git status --short` 빈 출력을 확인).
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
DEV_LOG = os.environ.get("DEV_LOG", os.path.join(tempfile.gettempdir(), "rd-008-positive-control-dev.log"))

CONTROLS = {
    "1": {
        "file": "packages/pyodide-core/src/worker/stdin-callback.ts",
        "find": "    deps.checkInterrupt();\n",
        "replace": "",
        "scripts": [
            ["input-cancel-check.mjs", URL, {"ONLY": "RM2"}],
            ["input-cancel-check.mjs", URL, {"ONLY": "E1"}],
        ],
    },
    "2": {
        "file": "packages/pyodide-core/src/worker/boot.ts",
        "find": "        signalInterrupt: () => signalInterrupt(interruptBuffer),",
        "replace": "        signalInterrupt: () => Atomics.store(interruptBuffer, 0, 2),",
        "scripts": [
            ["input-cancel-check.mjs", URL, {"ONLY": "T35"}],
            ["input-cancel-check.mjs", URL, {"ONLY": "RM2"}],
        ],
    },
    "3": {
        # RD-018 DELTA-04 경로 정정(멈추는 지점 3): 이 게이트는 RD-010의 세션 추출로 index.ts에서 session.ts의
        # `pythonRunning` 계산식으로 옮겨졌다(문자열은 그대로, 파일과 들여쓰기(2→4칸)만 다르다).
        # RD-020 DELTA-04 경로 정정: 게이트가 core 세션(`alive && inputReadsPending === 0 && !driver.isIdle()`)과 REPL main
        # driver의 `isIdle`로 갈렸다. `cancelSettling` 항이 있는 곳은 REPL의 `isIdle`이라 그 항을 뺀다(같은 변조, 파일만 다르다).
        "file": "packages/pyodide-repl/src/repl-main-driver.ts",
        "find": "    isIdle: () => readLinePending || cancelSettling,",
        "replace": "    isIdle: () => readLinePending,",
        "scripts": [
            ["prompt-cancel-check.mjs", URL, {"ONLY": "I"}],
            ["prompt-cancel-check.mjs", URL, {"ONLY": "RM1"}],
        ],
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
    subprocess.Popen(
        ["pnpm", "exec", "vite", "--port", "5173", "--strictPort"],
        cwd=str(REPO / "apps" / "demo"),
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    for _ in range(100):
        if sh(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", URL]).stdout == "200":
            return
        time.sleep(0.2)
    sys.exit("dev 서버가 뜨지 않았다")


def run_scripts(scripts):
    out = []
    for script in scripts:
        env = None
        if isinstance(script[-1], dict):
            env = {**os.environ, **script[-1]}
            script = script[:-1]
        r = sh(["node", str(CHECKS / script[0]), *script[1:]], cwd=str(CHECKS), timeout=1800, env=env)
        lines = r.stdout.splitlines()
        fails = [re.sub(r"\s+—.*$", "", l[6:]) for l in lines if l.startswith("FAIL")]
        passes = sum(1 for l in lines if l.startswith("PASS"))
        detail = {re.sub(r"\s+—.*$", "", l[6:]): l for l in lines if l.startswith("FAIL")}
        label = script[0] + (
            f" {','.join(f'{k}={v}' for k, v in env.items() if k in ('ONLY', 'COMBOS', 'N'))}" if env else ""
        )
        out.append((label, passes, fails, detail, r.returncode))
    return out


def report(tag, results):
    for name, passes, fails, detail, code in results:
        print(f"[{tag}] {name}: PASS {passes}, FAIL {len(fails)} {fails} exit={code}")
        for f in fails:
            print(f"   FAIL {detail[f][6:400]}")


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
