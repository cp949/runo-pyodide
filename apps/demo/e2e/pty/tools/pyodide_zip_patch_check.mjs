// 참고용 보조 진단(DELTA-02a 사전 확인, 채택 아님): _is_stdlib_module만 zipimporter도 stdlib로 인정하도록 오버라이드한
// 서브클래스를 pyodide에서 lines_B.json 전체에 돌려, 네이티브 결과와 같아지는 줄/남는 차이 줄을 기록한다.
// 사용: node pyodide_zip_patch_check.mjs --dir <작업 폴더> [--pyodide <pyodide 패키지 폴더>]
// 작업 폴더에 lines_B.json·native_result.json·pyodide_result.json이 먼저 있어야 하고, pyodide_zip_patch_check.json을 같은 폴더에 쓴다.
// 서술 산출물이라 기준 대조 대상이 아니다. pyodide 해석 순서는 resolve_pyodide.mjs 상단 주석.
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { importPyodide, splitPyodideArg } from './resolve_pyodide.mjs'

const { pyodide: pyodideArg, rest } = splitPyodideArg(process.argv.slice(2))
const dirIdx = rest.indexOf('--dir')
if (dirIdx < 0 || !rest[dirIdx + 1]) {
  console.error('사용: node pyodide_zip_patch_check.mjs --dir <작업 폴더> [--pyodide <폴더>]')
  process.exit(2)
}
const here = resolve(rest[dirIdx + 1])
const lines = JSON.parse(readFileSync(join(here, 'lines_B.json'), 'utf8')).map((r) => r.line)
const nat = JSON.parse(readFileSync(join(here, 'native_result.json'), 'utf8')).rows
const pyo = JSON.parse(readFileSync(join(here, 'pyodide_result.json'), 'utf8')).rows
const { loadPyodide, dir, source, version } = await importPyodide(pyodideArg)
console.log(`pyodide 패키지(${source}): ${dir} (package.json version ${version})`)
const pyodide = await loadPyodide()
pyodide.runPython(`
import json
from importlib.machinery import FileFinder
from zipimport import zipimporter
from _pyrepl._module_completer import ModuleCompleter

class PatchedModuleCompleter(ModuleCompleter):
    def _is_stdlib_module(self, module_info):
        f = module_info.module_finder
        if isinstance(f, FileFinder):
            return f.path == self._stdlib_path
        return isinstance(f, zipimporter) and f.archive == self._stdlib_path

def run(lines_json):
    return json.dumps([PatchedModuleCompleter().get_completions(l) for l in json.loads(lines_json)])
`)
const patched = JSON.parse(pyodide.globals.get('run')(JSON.stringify(lines)))
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const out = { fixed_by_patch: [], still_differs: [], regressed: [] }
lines.forEach((line, i) => {
  const [n, p, q] = [nat[i].result, pyo[i].result, patched[i]]
  if (!eq(n, p) && eq(n, q)) out.fixed_by_patch.push(line)
  else if (!eq(n, q)) out.still_differs.push({ line, native_n: n === null ? null : n.length, patched_n: q === null ? null : q.length })
  if (eq(n, p) && !eq(n, q)) out.regressed.push(line)
})
writeFileSync(join(here, 'pyodide_zip_patch_check.json'), JSON.stringify(out, null, 1))
console.log('fixed_by_patch', JSON.stringify(out.fixed_by_patch))
console.log('still_differs', out.still_differs.length, '| regressed', JSON.stringify(out.regressed))
