"""cases_import.json의 그룹을 CPython 3.14 pty(훅 포함)로 돌려 res_<그룹>.json을 만든다(rd-016 측정 A).

사용(하니스 venv의 python으로 실행, 대상 인터프리터는 --python / PTY_PYTHON / PATH의 python3.14):
  <venv>/bin/python runcases_import.py import import_extra --dir <출력 폴더> [--python P]
  <venv>/bin/python runcases_import.py import --lo 0 --hi 5 --dir <출력 폴더>   (부분 실행: res_import_0.json)
  <venv>/bin/python runcases_import.py import --out <파일>                     (단일 그룹의 출력 파일을 직접 지정)

- 그룹을 여러 개 주면 한 프로세스에서 순서대로 돈다(그룹마다 케이스별 새 pty 세션). rd-016 기준 파일은
  `import` -> res_import.json, `import_extra` -> res_import_extra.json.
- 케이스마다 새 pty 세션(setup 5줄 실행 뒤 Ctrl+L)을 띄운다.
- 개행이 있는 입력은 bracketed paste로 넣고, 없으면 글자를 한 번에 보낸다.
- Tab을 case["tabs"]회 보내며 매 Tab 뒤의 화면·커서와 그 Tab이 만든 훅 기록({stem,buf,pos,res,mc})을 저장한다.
- 훅의 mc 필드(ModuleCompleter 원시 결과)는 기본으로 켠다(rd-016 기준에 있다). 끄려면 --no-mc.
- 입력 기본값은 저장소 기준 데이터의 apps/demo/e2e/pty/rd-016/cases_import.json이다(읽기 전용).
"""
import argparse
import json
import os
import sys

from common import *
import ptyrepl

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CASES = os.path.normpath(os.path.join(HERE, "..", "rd-016", "cases_import.json"))


def run_group(cfg, group, lo, hi, with_mc):
    out = {}
    for case in cfg[group][lo:hi]:
        text = case["text"]
        s = fresh(cfg["setup"], with_mc=with_mc)
        if "\n" in text:
            s.send(PASTE_BEGIN + text.encode() + PASTE_END, 0.4)
        else:
            s.type(text)
        typed = s.lines()
        typed_cursor = (s.screen.cursor.y, s.screen.cursor.x)
        steps = []
        seen = 0
        for i in range(case["tabs"]):
            s.send(TAB, 0.5)
            ents = log_entries(s)
            steps.append({
                "tab": i + 1,
                "screen": s.lines(),
                "cursor": [s.screen.cursor.y, s.screen.cursor.x],
                "log": ents[seen:],
            })
            seen = len(ents)
        s.close()
        out[text] = {"id": case["id"], "group": case["group"], "tabs": case["tabs"], "note": case["note"],
                     "typed": typed, "typed_cursor": list(typed_cursor), "steps": steps}
        e = steps[0]["log"][0] if steps[0]["log"] else None
        if e:
            r = e["res"]
            mc = e.get("mc", "-")  # --no-mc면 필드가 없다
            mcs = mc if isinstance(mc, str) else ("None" if mc is None else len(mc))
            print(f"{case['id']} {text!r:44} stem={e['stem']!r:12} mc={mcs!s:>4} n={len(r):3d} first={r[:4]}", flush=True)
        else:
            print(f"{case['id']} {text!r:44} (get_completions 미호출)", flush=True)
        print(f"      Tab#1 screen: {steps[0]['screen']}", flush=True)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("groups", nargs="+", help="cases_import.json의 그룹 이름(import, import_extra)")
    ap.add_argument("--cases", default=DEFAULT_CASES, help=f"케이스 정의 JSON(기본: {DEFAULT_CASES})")
    ap.add_argument("--dir", default=None, help="출력 폴더(res_<그룹>.json을 여기에 쓴다). --out이 없으면 필수")
    ap.add_argument("--lo", type=int, default=0, help="시작 인덱스(단일 그룹만)")
    ap.add_argument("--hi", type=int, default=None, help="끝 인덱스(단일 그룹만)")
    ap.add_argument("--no-mc", dest="with_mc", action="store_false", default=True,
                    help="훅 log 항목에 mc 필드를 기록하지 않는다(기본은 기록: rd-016 재생성)")
    add_out_arg(ap)
    ptyrepl.add_interpreter_args(ap)
    args = ap.parse_args(argv)

    multi = len(args.groups) > 1
    if multi and (args.out or args.lo != 0 or args.hi is not None):
        ap.error("--out·--lo·--hi는 그룹이 하나일 때만 쓴다")
    if not args.out and not args.dir:
        ap.error("--dir 또는 --out이 필요하다")
    cfg = json.load(open(args.cases))
    for g in args.groups:
        if g == "setup" or g not in cfg:
            ap.error(f"cases 파일에 없는 그룹: {g} (있는 그룹: {[k for k in cfg if k != 'setup']})")

    interp = ptyrepl.setup_from_args(args)
    print(f"인터프리터({interp.source}): {interp.path}\n버전: {interp.version}\nwith_mc: {args.with_mc}", flush=True)

    for g in args.groups:
        default = os.path.join(args.dir or ".", f"res_{g}.json" if args.lo == 0 and args.hi is None else f"res_{g}_{args.lo}.json")
        path = resolve_out(args.out, default)
        out = run_group(cfg, g, args.lo, args.hi, args.with_mc)
        with open(path, "w") as f:
            json.dump(out, f, ensure_ascii=False, indent=1)
        print(f"쓴 파일: {path} ({len(out)}케이스)", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
