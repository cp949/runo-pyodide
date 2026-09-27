// pyodide 고정 버전의 코드 쪽 원천. 버전 값의 원천은 `pnpm-workspace.yaml` catalog이고(ADR-0007), 여기서는 설치된
// `pyodide/package.json`의 `version`을 읽어 유도한다 — 코드·시험에 버전 리터럴을 두지 않는다.
// 번들에서는 `tsdown.config.ts`가 `pyodide/package.json`만 external에서 빼서 JSON이 인라인된다(런타임 `pyodide` import 없음).
import pyodidePackage from "pyodide/package.json" with { type: "json" };

/** 이 패키지가 검증한 pyodide 버전. worker가 로드한 `pyodide.version`과 비교하는 기준이다. */
export const PYODIDE_VERSION: string = pyodidePackage.version;

/** 기본 pyodide CDN 위치. 끝 `/`를 포함한다(`00-architecture.md` 4.1). */
export const DEFAULT_PYODIDE_INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
