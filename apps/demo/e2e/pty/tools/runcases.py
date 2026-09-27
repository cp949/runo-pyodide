"""rd-015 Tab 완성 기준 데이터(res_s*.json)를 CPython 3.14 pty(훅 포함)로 재생성한다.

사용(하니스 venv의 python으로 실행, 대상 인터프리터는 --python / PTY_PYTHON / PATH의 python3.14):
  <venv>/bin/python runcases.py SPEC [SPEC ...] --dir <출력 폴더> [--python P] [--cases cases.json]

SPEC = 그룹[:lo[:hi]][=출력파일명]
  s10          그룹 s10 전체(lo=0, hi=끝)  -> <dir>/res_s10_0.json
  s10:0:13     그룹 s10의 [0:13)           -> <dir>/res_s10_0.json
  s10:13       그룹 s10의 [13:끝)          -> <dir>/res_s10_13.json
  s1=res_s1.json  출력 파일명을 직접 지정(기준 파일명이 `res_<그룹>_<lo>.json` 규칙과 다를 때)
- 기본 출력명은 `res_<그룹>_<lo>.json`이다(hi는 이름에 넣지 않는다).
- SPEC을 여러 개 주면 한 프로세스에서 순서대로 돈다(케이스마다 새 pty 세션이라 결과는 분리 실행과 같다).
  rd-015 기준 7파일을 한 번에 만드는 명령은 아래와 같다.
    runcases.py s1=res_s1.json s2 s7:0:11 s7:11:22 s7:22 s10:0:13 s10:13 --dir <출력 폴더>
- 케이스마다 새 pty 세션(setup 5줄 실행 뒤 Ctrl+L)에 글자를 한 번에 보내고 Tab을 두 번 보낸다.
  기록: typed(입력 직후 화면), log(훅 기록 {stem,buf,pos,res}), screen1·cursor1(첫 Tab 뒤), screen2(둘째 Tab 뒤).
- 훅의 mc 필드(ModuleCompleter 원시 결과)는 기본으로 끈다(rd-015 기준에 없다). 켜려면 --with-mc(rd-016 전용).
- 입력 기본값은 저장소 기준 데이터의 apps/demo/e2e/pty/rd-015/cases.json이다(읽기 전용).
"""
import argparse
import json
import os
import sys

from common import *
import ptyrepl

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CASES = os.path.normpath(os.path.join(HERE, "..", "rd-015", "cases.json"))


def parse_spec(spec):
    """'그룹[:lo[:hi]][=파일명]' -> (그룹, lo, hi, 파일명 또는 None). 잘못된 형식이면 ValueError."""
    name = None
    if "=" in spec:
        spec, name = spec.split("=", 1)
        if not name:
            raise ValueError(f"빈 출력 파일명: {spec}=")
    parts = spec.split(":")
    if len(parts) > 3 or not parts[0]:
        raise ValueError(f"SPEC 형식은 그룹[:lo[:hi]][=파일명]이다: {spec!r}")
    lo = int(parts[1]) if len(parts) > 1 and parts[1] != "" else 0
    hi = int(parts[2]) if len(parts) > 2 and parts[2] != "" else None
    return parts[0], lo, hi, name


def run_group(cfg, group, lo, hi, with_mc):
    out = {}
    for src in cfg[group][lo:hi]:
        s = fresh(cfg["setup"], with_mc=with_mc)
        s.type(src)
        b0 = s.lines()
        s.send(TAB)
        scr1 = s.lines()
        cur1 = (s.screen.cursor.y, s.screen.cursor.x)
        s.send(TAB)
        scr2 = s.lines()
        ents = log_entries(s)
        out[src] = {"typed": b0, "log": ents, "screen1": scr1, "cursor1": cur1, "screen2": scr2}
        s.close()
        e = ents[0] if ents else None
        if e:
            r = e["res"]
            print(f"{src!r:24} stem={e['stem']!r:14} n={len(r):3d} first={r[:5]}", flush=True)
        else:
            print(f"{src!r:24} (get_completions 미호출)", flush=True)
        print(f"      Tab#1 screen: {scr1}", flush=True)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("specs", nargs="+", metavar="SPEC", help="그룹[:lo[:hi]][=출력파일명] (여러 개 가능)")
    ap.add_argument("--cases", default=DEFAULT_CASES, help=f"케이스 정의 JSON(기본: {DEFAULT_CASES})")
    ap.add_argument("--dir", default=None, help="출력 폴더. --out이 없으면 필수")
    add_out_arg(ap)
    add_with_mc_arg(ap)
    ptyrepl.add_interpreter_args(ap)
    args = ap.parse_args(argv)

    if not args.out and not args.dir:
        ap.error("--dir 또는 --out이 필요하다")
    if args.out and len(args.specs) > 1:
        ap.error("--out은 SPEC이 하나일 때만 쓴다(여러 개면 SPEC의 =파일명을 쓴다)")
    cfg = json.load(open(args.cases))
    plan = []
    for spec in args.specs:
        try:
            g, lo, hi, name = parse_spec(spec)
        except ValueError as e:
            ap.error(str(e))
        if g == "setup" or g not in cfg:
            ap.error(f"cases 파일에 없는 그룹: {g} (있는 그룹: {[k for k in cfg if k != 'setup']})")
        n = len(cfg[g])
        if not 0 <= lo <= n or (hi is not None and not lo <= hi <= n):
            ap.error(f"범위가 그룹 크기({n})를 벗어난다: {spec}")
        default = os.path.join(args.dir or ".", name or f"res_{g}_{lo}.json")
        plan.append((g, lo, hi, args.out or default))
    paths = [p for *_, p in plan]
    if len(set(os.path.abspath(p) for p in paths)) != len(paths):
        ap.error(f"출력 파일이 겹친다: {paths}")

    interp = ptyrepl.setup_from_args(args)
    print(f"인터프리터({interp.source}): {interp.path}\n버전: {interp.version}\nwith_mc: {args.with_mc}", flush=True)

    for g, lo, hi, out_path in plan:
        path = resolve_out(out_path, out_path)
        print(f"== 그룹 {g} [{lo}:{hi if hi is not None else ''}] -> {path}", flush=True)
        out = run_group(cfg, g, lo, hi, args.with_mc)
        with open(path, "w") as f:
            json.dump(out, f, ensure_ascii=False, indent=1)
        print(f"쓴 파일: {path} ({len(out)}케이스)", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
