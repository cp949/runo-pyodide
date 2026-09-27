// pyodide(Node)에서 mc_probe.probe를 lines json에 돌려 pyodide_result*.json을 만든다.
// 사용: node pyodide_complete.mjs <입력 lines json> <출력 json> [--pyodide <pyodide 패키지 폴더>]
// pyodide 해석 순서는 resolve_pyodide.mjs 상단 주석. 결과 JSON에 pyodide_version(=pyodide/package.json의 version)을 기록한다.
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { importPyodide, splitPyodideArg } from './resolve_pyodide.mjs'

const { pyodide: pyodideArg, rest } = splitPyodideArg(process.argv.slice(2))
if (rest.length < 2) {
  console.error('사용: node pyodide_complete.mjs <입력 lines json> <출력 json> [--pyodide <폴더>]')
  process.exit(2)
}
const inp = resolve(rest[0])
const outp = resolve(rest[1])
const lines = JSON.parse(readFileSync(inp, 'utf8')).map((r) => r.line)
const src = readFileSync(new URL('mc_probe.py', import.meta.url), 'utf8')
const { loadPyodide, dir, source, version } = await importPyodide(pyodideArg)
console.log(`pyodide 패키지(${source}): ${dir} (package.json version ${version})`)
const pyodide = await loadPyodide()
pyodide.runPython(src)
const probe = pyodide.globals.get('probe')
const out = JSON.parse(probe(JSON.stringify(lines)))
out.pyodide_version = version
if (pyodide.version !== version) console.warn(`경고: 런타임 pyodide.version(${pyodide.version}) != package.json version(${version})`)
writeFileSync(outp, JSON.stringify(out, null, 1))
console.log('pyodide', version, out.python.split(' ')[0], 'cwd =', out.cwd, 'rows =', out.rows.length, 'sys.modules 추가 =', JSON.stringify(out.sys_modules_added))
