#!/usr/bin/env python3
"""양성 대조 드라이버(RD-007). 확인 스크립트가 결함을 실제로 잡는지 소스를 변조해 본다.

출처: RD-007에서 이관했다(RD-018). 짝이 되는 `.md` 기록은 없다.
규칙: `apps/demo/e2e/README.md`의 "양성 대조(positive-controls)"를 따른다.

한 번의 실행(`CONTROLS[번호]`):
1. 대상 파일이 깨끗한지 확인한다. 아니면 중단한다.
2. `find`를 `replace`로 바꿔 소스를 변조한다. 첫 한 곳만 바꾼다.
3. dev 서버를 재시작하고 확인 스크립트를 돌린다(`[변조]` 줄).
4. `git checkout -- <파일>`로 원복한다.
5. dev 서버를 재시작하고 같은 스크립트를 다시 돌린다(`[원복]` 줄).

이 드라이버는 기대를 판정하지 않는다. 결과 줄만 출력한다.
`[변조]`에서 아래 기대 셀만 실패하고 `[원복]`이 전부 통과하는지는 사람이 대조한다(TRP-029).

사용: python3 rd-007.py <1|2|3>
- 2번은 환경변수 `N`(기본 200)으로 press-loss 시행 수를 정한다.

변조와 기대:
- 1: `packages/pyodide-repl/src/repl-main-driver.ts`의 `sinks.write("^C")`를 `readline.print("^C")`로 바꾼다.
  - 확인은 `checks/ctrl-c-check.mjs`를 `ONLY=S1`, `ONLY=G1`로 셀마다 돌린다.
  - 기대: S1이 실패한다. `^C`가 꼬리에 안 남아 `t^Cx: abc`가 되지 않는다.
  - G1은 통과해야 한다. 트레이스백은 에코 방식과 무관하다.
- 2: `packages/pyodide-core/src/protocol/interrupt-sender.ts`의 재전송(`Atomics.compareExchange`) 삭제.
  - 확인은 `measure/press-loss.mjs`다.
  - 기대: HANG이 0이 아니다. 소실은 확률적이라 "0이 아님"만 판정한다.
- 3: `packages/pyodide-core/src/worker/sigint-handler.py`의 사용자 프레임 판별을 `if True:`로 바꿔 항상 raise한다.
  - 확인은 `measure/burst-matrix.mjs`를 `COMBOS=a`, `N=20`으로 돌린다.
  - 기대: DIRTY 또는 CRASH가 0보다 크다.

전제:
- 확인 스크립트 경로는 `apps/demo/e2e` 기준이다. `press-loss`·`burst-matrix`는 성능 측정이라 `measure/`에 있다.
- 깨끗한 트리에서만 실행한다. 시작 전 `git status --short`가 비어야 한다.
- dev 서버(5173)를 변조·원복마다 다시 띄운다(TRP-007). 끝나면 dev 서버가 하나 남으니 직접 정리한다.
- 원복은 `git checkout -- <파일>`이다.
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

# 변조 표. 필드:
# - `file`: 변조 대상(저장소 루트 기준).
# - `find`: 바꿀 문자열. 파일에 있어야 한다.
# - `replace`: 바꾼 뒤 문자열.
# - `scripts`: 돌릴 확인 `[파일, 인자..., {환경변수}]` 목록.
CONTROLS = {
    "1": {
        # `sinks.write("^C")`는 원래 index.ts에 있었다.
        # RD-010의 세션 추출로 session.ts의 `echoCtrlC()`로 옮겼다.
        # RD-020이 session.ts를 core 세션과 REPL main driver로 나눠 `repl-main-driver.ts`로 갔다.
        # 문자열·들여쓰기는 그대로다. `readline`은 `createReplMainDriver`의 옵션으로 스코프에 있어 같은 변조가 적용된다.
        "file": "packages/pyodide-repl/src/repl-main-driver.ts",
        "find": '      sinks.write("^C");',
        "replace": '      readline.print("^C");',
        # S1만 `^C`의 위치를 본다.
        # G1(트레이스백)은 에코 방식과 무관하니 통과해야 한다(해당 확인만 실패한다는 대조).
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
        # 이 판정 로직은 원래 `sigint-handler.ts`에 있었다.
        # 이후 `sigint-handler.py`(Python 소스, `?raw` import)로 옮겼다.
        # ts에는 그 소스를 심는 JS 래퍼만 남았다.
        # find·replace 문자열·들여쓰기는 그대로다(같은 한 줄).
        "file": "packages/pyodide-core/src/worker/sigint-handler.py",
        "find": "            if f.f_code.co_filename == user_filename:",
        "replace": "            if True:",
        "scripts": [["measure/burst-matrix.mjs", URL, {"COMBOS": "a", "N": "20"}]],
    },
}


def sh(args, **kw):
    """`subprocess.run`을 출력 수집(text)으로 부른다. `CompletedProcess`를 돌려준다."""
    return subprocess.run(args, capture_output=True, text=True, **kw)


def dev_pid():
    """5173 포트를 듣는 프로세스의 pid를 돌려준다. 없으면 `None`이다. `ss -ltnp` 출력에서 읽는다."""
    m = re.search(r":5173\b.*?pid=(\d+)", sh(["ss", "-ltnp"]).stdout)
    return int(m.group(1)) if m else None


def restart_dev():
    """dev 서버를 다시 띄운다.

    - 떠 있는 서버는 SIGTERM으로 끝내고 약 5초까지 기다린다.
    - `apps/demo`에서 `pnpm exec vite --port 5173 --strictPort`를 새 세션으로 띄운다.
    - 서버 로그는 `DEV_LOG`에 덧붙인다.
    - 응답 코드 200이 올 때까지 약 20초 기다린다. 안 오면 종료한다.

    재시작하는 이유:
    - `git checkout`이 파일을 새 inode로 바꾸면 Vite 감시가 그 파일을 놓친다.
    - 그러면 서버가 낡은 모듈을 계속 준다(TRP-007).
    - 변조와 원복 때마다 재시작해 최신 소스를 읽게 한다.
    """
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
    """확인 스크립트를 차례로 돌려 결과를 모은다.

    인자 `scripts`는 `[파일, 인자..., {환경변수}]` 목록이다. 마지막 원소가 dict면 환경변수로 더한다.
    `apps/demo/e2e`에서 `node`로 돌리고 스크립트당 제한 시간은 1800초다.

    반환: `(라벨, PASS 수, FAIL 이름들, {FAIL 이름: FAIL 줄}, 종료 코드, 끝 요약)` 목록이다.
    - 라벨: 파일 이름과 `ONLY`·`COMBOS`·`N` 값.
    - PASS·FAIL: 출력에서 `PASS`·`FAIL`로 시작하는 줄이다.
    - FAIL 이름: FAIL 줄에서 접두 `FAIL  `과 `  —` 뒤 사유를 뗀 것.
    - 끝 요약: PASS·FAIL 줄이 하나도 없을 때만 출력 끝 40줄이다. 아니면 빈 문자열이다.
    """
    out = []
    for script in scripts:
        # 마지막 원소가 dict면 환경변수다(`ONLY`·`COMBOS`·`N`).
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
        # 판정이 PASS/FAIL 줄이 아닌 스크립트(press-loss·burst-matrix)가 있다.
        # 그런 스크립트는 종료 코드와 끝 요약으로 본다.
        summary = "\n".join(lines[-40:]) if not lines or passes + len(fails) == 0 else ""
        out.append((label, passes, fails, detail, r.returncode, summary))
    return out


def report(tag, results):
    """`run_scripts` 결과를 `[태그] 라벨: PASS n, FAIL m [...] exit=코드` 줄로 출력한다.

    FAIL 줄은 앞 300자까지(접두 6자는 뗀다), 끝 요약이 있으면 뒤 1200자까지 덧붙인다.
    """
    for name, passes, fails, detail, code, summary in results:
        print(f"[{tag}] {name}: PASS {passes}, FAIL {len(fails)} {fails} exit={code}")
        for f in fails:
            print(f"   FAIL {detail[f][6:300]}")
        if summary:
            print(f"   요약: {summary[-1200:]}")


def main(key):
    """변조 → 확인 → 원복 → 재확인을 한 번 돌리고 결과를 출력한다.

    인자 `key`는 `CONTROLS`의 번호다.
    - 대상 파일이 깨끗하지 않거나 `find`가 없으면 중단한다.
    - 확인 도중 예외가 나도 `finally`에서 `git checkout -- <파일>`로 원복한다.
    - 기대와 실제 결과의 대조는 하지 않는다.
    """
    c = CONTROLS[key]
    path = REPO / c["file"]
    if sh(["git", "diff", "--quiet", "--", c["file"]], cwd=str(REPO)).returncode != 0:
        sys.exit(f"대상 파일이 깨끗하지 않다: {c['file']}")
    original = path.read_text(encoding="utf-8")
    if c["find"] not in original:
        sys.exit(f"find 문자열이 없다: {c['find']!r}")
    # 변조 적용 뒤 확인을 돌린다. 예외가 나도 원복한다.
    try:
        path.write_text(original.replace(c["find"], c["replace"], 1), encoding="utf-8")
        print(f"== 양성 대조 {key}: 변조 적용({c['file']})", flush=True)
        restart_dev()
        mutated = run_scripts(c["scripts"])
    finally:
        sh(["git", "checkout", "--", c["file"]], cwd=str(REPO))
    # 원복 뒤 대상 파일이 깨끗한지 확인한다.
    restored_clean = sh(["git", "diff", "--quiet", "--", c["file"]], cwd=str(REPO)).returncode == 0
    print(f"원복(git checkout) 후 깨끗함: {restored_clean}")
    report("변조", mutated)
    # 원복한 소스로 같은 확인을 다시 돌린다. 전부 통과해야 한다.
    print("== 원복 후 재실행", flush=True)
    restart_dev()
    report("원복", run_scripts(c["scripts"]))


# `if __name__` 가드가 없다. 실행하면 바로 `main`을 부른다.
main(sys.argv[1])
