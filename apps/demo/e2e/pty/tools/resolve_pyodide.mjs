// node 도구 공용: pyodide 패키지 폴더를 해석하고 loadPyodide를 불러온다. 이 저장소는 apps/demo에 pyodide 의존을 두지 않는다
// (check-dist·smoke:pack 표면을 건드리지 않으려고). 그래서 이 파일이 있는 폴더에서 바로 해석되지 않을 수 있다.
//
// 해석 순서:
//   1. --pyodide <폴더>          (pyodide.mjs·package.json이 있는 폴더)
//   2. createRequire(import.meta.url).resolve('pyodide/package.json')   (이 폴더 기준 일반 해석)
//   3. 저장소 워크스페이스 폴백: pnpm-workspace.yaml이 있는 조상 폴더의 packages/{pyodide-core,pyodide-repl,pyodide-dom-bridge}/node_modules/pyodide
// 어느 것도 없으면 오류로 끝낸다(종료 코드 2).
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKSPACE_PACKAGES = ['pyodide-core', 'pyodide-repl', 'pyodide-dom-bridge']

/** argv에서 `--pyodide <폴더>`를 뽑아내고 남은 인자를 돌려준다. */
export function splitPyodideArg(argv) {
  const rest = []
  let pyodide = null
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--pyodide') pyodide = argv[++i]
    else rest.push(argv[i])
  }
  return { pyodide, rest }
}

function findWorkspaceRoot() {
  let dir = HERE
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

/** pyodide 패키지 폴더와 어느 규칙으로 찾았는지를 돌려준다. */
export function resolvePyodideDir(explicit) {
  if (explicit) {
    const dir = resolve(explicit)
    if (!existsSync(join(dir, 'pyodide.mjs'))) throw new Error(`--pyodide 폴더에 pyodide.mjs가 없다: ${dir}`)
    return { dir, source: '--pyodide' }
  }
  try {
    const pkg = createRequire(import.meta.url).resolve('pyodide/package.json')
    return { dir: dirname(pkg), source: 'createRequire' }
  } catch {
    // 아래 워크스페이스 폴백으로 넘어간다
  }
  const root = findWorkspaceRoot()
  if (root) {
    for (const name of WORKSPACE_PACKAGES) {
      const dir = join(root, 'packages', name, 'node_modules', 'pyodide')
      if (existsSync(join(dir, 'pyodide.mjs'))) return { dir, source: `workspace:packages/${name}` }
    }
  }
  throw new Error(
    "pyodide를 찾지 못했다. 순서: --pyodide <폴더> > createRequire('pyodide') > packages/{pyodide-core,pyodide-repl,pyodide-dom-bridge}/node_modules/pyodide. `pnpm install`을 먼저 실행한다.",
  )
}

/** { loadPyodide, dir, source, version }. version은 pyodide/package.json의 version이다. */
export async function importPyodide(explicit) {
  const { dir, source } = resolvePyodideDir(explicit)
  const version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version
  const { loadPyodide } = await import(pathToFileURL(join(dir, 'pyodide.mjs')).href)
  return { loadPyodide, dir, source, version }
}
