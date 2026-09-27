/**
 * `import`/`from` 사전 게이트(`mentionsImportKeyword`, RD-016, TRAP-33)의 시험 코퍼스 55줄. `terminal/import-gate.test.ts`(JS 게이트 판정)와
 * `worker/complete-source.test.ts`(실제 pyodide의 원본 `ModuleCompleter`가 `None`인지, 안전성)가 함께 쓴다. 시험 전용이라 `index.ts`가
 * 내보내지 않는다. 추적 파일은 `_works/`를 참조할 수 없어 `apps/demo/e2e/pty/rd-016/gate_corpus.json`(53줄) + 대소문자 변형 2줄을 리터럴로
 * 옮겼고 측정 ID(C01~C53)를 주석으로 남겼다. 측정 C 53줄은 네이티브 3.14.4와 pyodide 314.0.7의 `None` 여부가 같았다.
 */

/** 게이트가 거짓(부분 문자열 `import`·`from`이 없음)인 줄. 전부 `None`이다. */
export const GATE_FALSE_LINES = [
  "x = 1", // C01
  "os.pa", // C02
  "print(", // C03
  "", // C08
  "   ", // C09
  "\t", // C10
  "def f():", // C11
  "    return x", // C12
  "os.path.join(a, b)", // C19
  "for x in range(3):", // C20
  "x = [i for i in y]", // C21
  "x = 1\ny = 2", // C22
  "def f():\n    return", // C23
  "ｉmport os", // C29: 전각 i라 NFKC로는 import지만 tokenize가 원문 그대로 다루므로 None이다.
  // 대소문자 변형(측정 C에 없음): 3.14 tokenize가 NAME 토큰을 원문 그대로 주고 ImportParser의 키워드 비교가 대소문자를 구분하므로 None이다. 게이트도 대소문자를 구분한다.
  "IMPORT os",
  "FROM os",
];

/** 게이트가 참이지만 `None`인 줄(오탐). 식별자·문자열·주석 안의 글자열이라 worker 왕복만 늘고 결과는 `None` 폴백과 같다. */
export const FALSE_POSITIVE_LINES = [
  "__import__('os')", // C04
  "important.x", // C05
  "imports.pa", // C06
  "reimport", // C07
  "fromage.x", // C13
  "from_ = 1", // C14
  "print(from_)", // C15
  "_import", // C16
  "import_x", // C17
  "x.imported", // C18
  "def f(from_=1): pass", // C30
  'x = "import os"', // C31
  "# from", // C32
  "# import os", // C33
  '"from a"', // C34
  "print('import')", // C35
  "x = 'from os import path'", // C36
  "foo.import", // C37
  "print(from", // C38
  "import", // C39
  "from", // C40
  "x = 1  # import", // C41
  "yield from", // C42
  "raise X from", // C43
  "이import os", // C44
  "import이 os", // C45
  "import os; os.pa", // C52
  "import os\nos.pa", // C53
];

/** 숫자 리터럴 바로 뒤에 키워드가 붙은 줄. 3.14 `tokenize`가 `NUMBER` + `NAME('import')`로 나눠 `ModuleCompleter`가 후보를 낸다(C24~C28). */
export const NUMERIC_LITERAL_LINES = [
  "1import os",
  "1from os",
  "1jimport os",
  "1.5from os",
  "0x1fimport os",
];

/** 게이트가 참이고 `ModuleCompleter`가 `None`이 아닌 줄. */
export const NON_NONE_LINES = [
  ...NUMERIC_LITERAL_LINES,
  "import os.pa", // C46
  "from os import pa", // C47
  "x = 1; import o", // C48
  "x = 1\nimport o", // C49
  "raise ValueError from o", // C50
  "import os  # c\n", // C51
];

/** 코퍼스 전체 55줄(게이트 거짓 16 + 오탐 28 + 참 양성 11). 숫자 리터럴 5줄은 참 양성 11줄에 포함된다. */
export const CORPUS = [
  ...GATE_FALSE_LINES,
  ...FALSE_POSITIVE_LINES,
  ...NON_NONE_LINES,
];
