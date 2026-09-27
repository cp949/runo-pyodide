# _pyrepl.readline.ReadlineAlikeReader.get_completions 호출을 기록만 한다(동작 변경 없음).
# mc 필드 = ModuleCompleter 원시 결과(None / [] / 후보 목록). res(최종 후보)만으로는
# None 폴백(공백 후보·rlcompleter 결과)과 [] 무동작을 구분할 수 없어서 넣는다.
# mc 필드는 환경변수 PTY_HOOK_MC=1일 때만 기록한다(기본 꺼짐). rd-015 기준 데이터의 log 항목에는 mc가 없고
# rd-016 기준 데이터에는 있어서, 훅 한 벌로 두 데이터를 모두 재생성하려고 조건화했다.
def _install():
    import json, os
    import _pyrepl.readline as rl
    cls = rl.ReadlineAlikeReader
    orig = cls.get_completions
    log = os.environ["COMPLOG"]
    with_mc = os.environ.get("PTY_HOOK_MC") == "1"
    def get_completions(self, stem):
        res = orig(self, stem)
        entry = {"stem": stem, "buf": "".join(self.buffer), "pos": self.pos, "res": res}
        if with_mc:
            try:
                mc = self.get_module_completions()
            except Exception as e:
                mc = "EXC:" + repr(e)
            entry["mc"] = mc
        with open(log, "a") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        return res
    cls.get_completions = get_completions
_install()
del _install
