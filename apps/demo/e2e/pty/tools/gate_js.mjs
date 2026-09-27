// 게이트 정규식 /\b(import|from)\b/를 JS(앱 main과 같은 엔진)로 lines json의 각 줄에 평가한다.
// 사용: node gate_js.mjs <입력 lines json> <출력 json>
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const lines = JSON.parse(readFileSync(resolve(process.argv[2]), 'utf8')).map((r) => r.line)
const gate = /\b(import|from)\b/
writeFileSync(resolve(process.argv[3]), JSON.stringify(lines.map((line) => gate.test(line)), null, 1))
console.log('gate_js', lines.length, '줄, 참', lines.filter((l) => gate.test(l)).length)
