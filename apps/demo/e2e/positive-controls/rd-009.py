#!/usr/bin/env python3
"""양성 대조 드라이버. 소스를 변조 → dev 서버 재시작(TRP-007) → 해당 확인만 실행(지정한
확인만 실패해야 함) → `git checkout`으로 원복 → 재시작 → 재실행(통과).
출처 RD-009, `_works/_completed/20260922-09-rd-009-idle-ctrl-c/verify/positive-controls.py`에서 이관(RD-018 DELTA-04).

사용: python3 rd-009.py <1|2|3>
  1: worker/boot.ts의 `suppressWebLoopReraise(...)` 호출 제거
       → ctrl-c-check.mjs 총 pageerror(재보고 포함) > 0 (재발)
  2: worker/sleep-slice.py의 `secs <= SLEEP_SLICE` 분기의 `poll()` 제거
       → sleep-await-check.mjs ONLY=sleep-0.01 중앙값이 30ms를 넘거나 실패
  3: worker/boot.ts의 `startInterruptWatch(...)` 호출 제거(stopWatch를 no-op으로)
       → sleep-await-check.mjs ONLY=arun5 셀이 5초 뒤에야 복귀(slow)
dev 서버(5173)는 이 드라이버가 변조·원복 때마다 다시 띄운다(끝나면 dev 서버가 하나 남는다, TRP-007).
원복은 `git checkout -- <파일>`이고 대상 파일은 시작 전에 깨끗해야 한다(아니면 중단). 깨끗한 트리에서만
실행해라(시작 전 `git status --short` 빈 출력을 확인).

경로 참고(RD-018 이관): ctrl-c-check.mjs는 apps/demo/e2e/checks/, sleep-await-check.mjs(canonical, RD-012판
16셀)는 apps/demo/e2e/measure/에 있다.
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
DEV_LOG = os.environ.get("DEV_LOG", os.path.join(tempfile.gettempdir(), "rd-009-positive-control-dev.log"))

CONTROLS = {
    "1": {
        "file": "packages/pyodide-core/src/worker/boot.ts",
        # RD-021 경로 정정: `warn` 주입이 수집기 `report`로 바뀌어 호출이 한 줄이 됐다(TRP-034).
        "find": (
            "    // WebLoop의 KeyboardInterrupt·SystemExit 재보고 억제. "
            "세션당 1회, 실패해도 REPL 동작은 그대로다(`webloop-handlers`로 알린다).\n"
            "    suppressWebLoopReraise(pyodide, { report: collector.report });\n"
        ),
        "replace": "",
        "scripts": [
            ["checks/ctrl-c-check.mjs", URL, {}],
        ],
    },
    "2": {
        "file": "packages/pyodide-core/src/worker/sleep-slice.py",
        "find": (
            "            original_sleep(secs)\n"
            "            poll()\n"
            "            return None\n"
        ),
        "replace": "            original_sleep(secs)\n            return None\n",
        "scripts": [
            ["measure/sleep-await-check.mjs", URL, {"ONLY": "sleep-0.01"}],
        ],
    },
    "3": {
        # RD-018 DELTA-04 경로 정정(멈추는 지점 3): 문자열은 그대로이나 boot.ts의 이 블록이 들여쓰기 2칸→4칸으로
        # 바뀌었다(호이스팅 관련 리팩토링, 주변 줄 132~133 주석 참고). find·replace를 그 들여쓰기에 맞췄다.
        "file": "packages/pyodide-core/src/worker/boot.ts",
        "find": (
            "    const stopWatch = startInterruptWatch({\n"
            "      interruptIdle,\n"
            "      atPrompt: () => session.atPrompt(),\n"
            "      hasPending: () => hasPendingInterrupt(interruptBuffer),\n"
            "      consume: () => consumeInterrupt(interruptBuffer),\n"
            "      discard: () => discardPendingInterrupt(interruptBuffer),\n"
            "    });\n"
        ),
        "replace": "    const stopWatch = () => {};\n",
        "scripts": [
            ["measure/sleep-await-check.mjs", URL, {"ONLY": "arun5"}],
        ],
    },
}


def sh(args, **kw):
    return subprocess.run(args, capture_output=True, text=True, **kw)


def dev_pid():
    m = re.search(r":5173\b.*?pid=(\d+)", sh(["ss", "-ltnp"]).stdout)
    return int(m.group(1)) if m else None


def restart_dev():
    """dev 서버를 다시 띄운다. `git checkout`이 파일을 새 inode로 바꾸면 Vite 감시가 그 파일을 놓쳐 낡은 모듈을
    계속 주므로(TRP-007) 변조·원복 때마다 재시작해 최신 소스를 읽게 한다."""
    pid = dev_pid()
    if pid:
        os.kill(pid, signal.SIGTERM)
        for _ in range(50):
            if dev_pid() is None:
                break
            time.sleep(0.1)
    log = open(DEV_LOG, "a")
    subprocess.Popen(
        ["pnpm", "--filter", "demo", "dev"],
        cwd=str(REPO),
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    for _ in range(150):
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
        path = script[0]
        full = path if os.path.isabs(path) else str(E2E / path)
        r = sh(["node", full, *script[1:]], cwd=str(E2E), timeout=1800, env=env)
        lines = r.stdout.splitlines()
        fails = [re.sub(r"\s+—.*$", "", l[6:]) for l in lines if l.startswith("FAIL")]
        passes = sum(1 for l in lines if l.startswith("PASS"))
        detail = {re.sub(r"\s+—.*$", "", l[6:]): l for l in lines if l.startswith("FAIL")}
        label = os.path.basename(full) + (
            f" {','.join(f'{k}={v}' for k, v in env.items() if k in ('ONLY', 'N'))}" if env else ""
        )
        # sleep-await-check.mjs·ctrl-c-check.mjs 둘 다 마지막에 JSON 요약을 찍는다. ctrl-c-check.mjs는 RD-007의
        # (아직 재보고를 빼고 세는) lib.mjs를 그대로 쓰므로 "pageErrors" 필드 자체는 재보고를 제외한다 — 양성 대조
        # ①(재보고 억제 제거)의 재발은 그 필드가 아니라 "webLoopReraises"(재보고로 분류된 건수)로 나타난다. 총계는
        # 둘의 합이다. sleep-await-check.mjs(양성 대조 ②·③)는 이미 총계를 "pageErrors"에 담으므로 webLoopReraises가
        # 없거나 0이라 합쳐도 그대로다.
        json_line = next((l for l in reversed(lines) if l.startswith("{")), None)
        page_errors = None
        web_loop_reraises = 0
        parsed = None
        if json_line:
            try:
                import json as _json

                blob = "\n".join(lines[lines.index(json_line):])
                parsed = _json.loads(blob)
                page_errors = parsed.get("pageErrors")
                web_loop_reraises = parsed.get("webLoopReraises") or 0
            except Exception:
                page_errors = None
        total_page_errors = (len(page_errors) if isinstance(page_errors, list) else page_errors)
        if total_page_errors is not None:
            total_page_errors += web_loop_reraises
        # sleep-await-check.mjs만 있는 필드: 셀별 중앙값(양성 대조 ②·③의 실제 판정 신호는 PASS/FAIL이 아니라 이 값이다 —
        # `step()`은 형식·프레임만 보고 중앙값 문턱은 별도로 집계하기 때문이다).
        cell_medians = None
        if parsed is not None:
            try:
                cell_medians = {k: v.get("median") for k, v in (parsed.get("cellResults") or {}).items()}
            except Exception:
                cell_medians = None
        out.append((label, passes, fails, detail, r.returncode, total_page_errors, web_loop_reraises, cell_medians))
    return out


def report(tag, results):
    for name, passes, fails, detail, code, total_page_errors, web_loop_reraises, cell_medians in results:
        reraise_note = f"(재보고 {web_loop_reraises}건 포함)" if web_loop_reraises else ""
        median_note = f" 셀중앙값={cell_medians}" if cell_medians else ""
        print(f"[{tag}] {name}: PASS {passes}, FAIL {len(fails)} {fails} exit={code} pageErrors총계={total_page_errors}{reraise_note}{median_note}")
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
