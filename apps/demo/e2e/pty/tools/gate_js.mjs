// 게이트 후보 정규식 `/\b(import|from)\b/`를 lines json의 각 줄에 JS(앱 main과 같은 엔진)로 평가한다.
// - 이 정규식은 채택하지 않은 후보다. `1import os` 류 입력에서 거짓인데 파서가 반응한다(`docs/design/07-tab-completion.md` 7.5, TRAP-33).
// - 입력은 `lines_C.json`, 출력은 `gate_js_C.json`이다. 출력은 줄마다 참·거짓을 담은 배열이다.
// - pyodide를 로드하지 않는다.
// - `build_gate_corpus.py`가 이 출력을 네이티브·pyodide 결과와 합친다(`tools/README.md`의 rd-016 의존 관계).
// 사용: node gate_js.mjs <입력 lines json> <출력 json>
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const lines = JSON.parse(readFileSync(resolve(process.argv[2]), 'utf8')).map((r) => r.line)
const gate = /\b(import|from)\b/
writeFileSync(resolve(process.argv[3]), JSON.stringify(lines.map((line) => gate.test(line)), null, 1))
console.log('gate_js', lines.length, '줄, 참', lines.filter((l) => gate.test(l)).length)
