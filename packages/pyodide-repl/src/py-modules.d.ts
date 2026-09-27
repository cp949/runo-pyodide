/** `.py` 파일을 문자열로 읽는다(vite 내장 `?raw`, tsdown은 tsdown.config.ts의 raw-text 플러그인). */
declare module "*.py?raw" {
  const source: string;
  export default source;
}
