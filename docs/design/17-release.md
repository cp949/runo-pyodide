# npm 공개 배포

> 2026-09-28 브레인스토밍 확정. 이 문서는 (1) 공개 범위, (2) 공개 매니페스트 규칙, (3) 라이선스, (4) release-it 흐름, (5) 실패 복구, (6) 사용자 준비물, (7) 검증을 적는다.

결론:

- 공개 패키지 6개를 모두 같은 버전으로 한 번에 올린다(lockstep). 첫 버전은 `0.1.0`.
- 루트 release-it 하나가 버전·CHANGELOG·git tag·GitHub Release를 맡고, npm publish는 pnpm이 한다(`workspace:*`·`catalog:` 치환).
- publish는 git push보다 먼저 한다.
  - npm publish는 되돌리기 어렵다(unpublish 72시간 제한).
  - git push 실패는 수동 push로 복구된다.
- 실제 publish는 사용자가 `pnpm release`로 실행한다. 저장소가 보장하는 것은 `pnpm release:check` 통과(17.7)까지다.

## 17.1 공개 범위

| 패키지                                                      | 공개   | 비고                                                                                    |
| ----------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------- |
| `@cp949/runo-xterm-readline`                                | 예     | 벤더링본(ADR-0003). terminal·repl의 내부 의존이다. README에 "직접 사용 비권장"을 적는다 |
| `@cp949/runo-pyodide-core`                                  | 예     |                                                                                         |
| `@cp949/runo-pyodide-terminal`                              | 예     | `./internal`은 repl 전용이고 안정성 보장이 없다(lockstep이 전제)                        |
| `@cp949/runo-pyodide-repl`                                  | 예     |                                                                                         |
| `@cp949/runo-pyodide-repl-react`                            | 예     | 대부분의 소비자 진입점                                                                  |
| `@cp949/runo-pyodide-dom-bridge`                            | 예     |                                                                                         |
| `@repo/pyodide-testkit`                                     | 아니오 | 시험 전용                                                                               |
| `@repo/eslint-config`·`@repo/typescript-config`·`demo`·루트 | 아니오 |                                                                                         |

xterm-readline을 terminal·repl에 번들하지 않는 이유:

- `Readline`은 terminal이 만든다(`packages/pyodide-terminal/src/surface.ts`).
- 그 인스턴스가 던진 오류를 repl이 `instanceof`로 판정한다(`packages/pyodide-repl/src/repl-main-driver.ts`의 `ReadTakenError`·`ReadCancelledError`).
- 두 패키지가 각자 번들하면 클래스가 두 벌이 된다. 판정이 거짓이 된다.
- terminal에만 번들하고 repl이 `./internal` 재export로 받는 안은 기각했다. import 6곳·빌드 설정·smoke를 바꿔야 한다.

## 17.2 공개 매니페스트 규칙

공개 6개 공통:

- `private` 필드 없음.
- `"license": "MIT"`, `files`에 라이선스 파일 포함(17.3).
- `publishConfig.access: "public"`. scoped 패키지는 기본이 restricted라 없으면 첫 publish가 실패한다.
- `description`·`keywords`를 둔다. `engines`는 두지 않는다(브라우저 라이브러리).
- `version`이 6개 모두 같다.
- 내부 의존(`@cp949/*`, `dependencies`·`peerDependencies`)은 `workspace:*`로 쓴다. pnpm이 publish·pack 때 정확한 버전으로 바꾼다. dom-bridge의 core peer도 정확한 버전이 된다(lockstep이라 문제없다).

이 규칙은 tarball 기준으로 `pnpm smoke:pack`이 검사한다(`scripts/pack-smoke/manifest.mjs`, 09-testing.md 9.8.3). 버전 일치는 tarball 여러 개를 함께 보는 판정이다. 패키지별 `checkPackedManifest`와 별도 함수로 둔다.

## 17.3 라이선스

- 루트 `LICENSE`: MIT, `Copyright (c) 2026 cp949`.
- 공개 패키지 5개(xterm-readline 제외)에 루트 `LICENSE` 사본을 둔다. tarball은 패키지 폴더만 담는다.
- xterm-readline은 `LICENSE-MIT`를 유지하고 원 고지(`Copyright 2021 Erik Bremen`) 아래에 `Copyright (c) 2026 cp949`를 더한다.

## 17.4 release-it 흐름

설정은 루트 `.release-it.json` 하나다. 도구 버전: `release-it` 21.1.0, `@release-it/bumper` 8.0.1, `@release-it/conventional-changelog` 12.0.2.

| 항목                                 | 값                                                                                     | 이유                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `npm`                                | `false`                                                                                | npm 플러그인은 `workspace:*`·`catalog:`를 치환하지 못한다            |
| `@release-it/bumper`                 | `in`: `packages/pyodide-core/package.json`, `out`: 공개 6개 `package.json`의 `version` | 루트는 private라 버전이 없다                                         |
| `@release-it/conventional-changelog` | preset `conventionalcommits`, `infile: CHANGELOG.md`                                   | 커밋 제목이 이미 `feat:`·`fix:` 접두어다. GitHub Release 본문도 이것 |
| `git.requireBranch`                  | `main`                                                                                 |                                                                      |
| `git.tagName`                        | `v${version}`                                                                          |                                                                      |
| `git.commitMessage`                  | `chore: 릴리스 v${version}`                                                            | 한글 커밋 규칙                                                       |
| `github.release`                     | `true`                                                                                 | `GITHUB_TOKEN` 필요                                                  |

release-it 21.1.0의 실행 순서(코드 확인):

- 수명주기: `init → beforeBump → bump → beforeRelease → release → afterRelease`.
- `release` 단계의 내부 플러그인 순서: `npm → git → github`(`lib/plugin/factory.js`).
- git `release()`가 commit → tag → push를 한 번에 한다(`lib/plugin/git/Git.js`).
- hook은 dry-run에서 실행되지 않고 로그만 남는다(`lib/shell.js`, 17.7).

`pnpm release [버전]`(첫 배포 `pnpm release 0.1.0`):

1. `before:init`: `pnpm check-types && pnpm lint && pnpm test && pnpm build`
2. bump: 공개 6개 `version` 갱신, `CHANGELOG.md` 갱신
3. `after:bump`: `node scripts/pack-smoke.mjs`(새 버전 tarball로 17.2 규칙·설치·import·tsc·Vite 해석)
4. `before:git:release`: `pnpm -r --filter "./packages/*" publish --access public --no-git-checks`. private 패키지는 건너뛴다. 의존 순서로 올린다. 이미 올라간 버전은 건너뛰므로 재실행할 수 있다
5. git commit → tag → push → GitHub Release

## 17.5 실패 복구

| 실패 지점      | 상태                   | 복구                                                                                                                                              |
| -------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1~3            | 외부 영향 없음         | bump가 바꾼 `packages/*/package.json`·`CHANGELOG.md`를 `git restore`로 되돌린다(`CHANGELOG.md`가 이번에 처음 생겼으면 지운다)                     |
| 4 도중         | 일부 패키지만 게시     | 원인을 고친다. `pnpm -r --filter "./packages/*" publish --access public --no-git-checks`를 다시 실행한다(게시된 버전은 건너뜀). 5를 수동으로 한다 |
| 5 push·Release | npm 게시됨, git 미반영 | `git push --follow-tags`, GitHub Release는 웹에서 만든다                                                                                          |

## 17.6 사용자 준비물

저장소가 대신할 수 없는 것(실제 publish 전에 사용자가 준비한다):

- `npm login`과 `@cp949` scope 게시 권한.
- 2FA가 켜져 있으면 `NPM_CONFIG_OTP` 환경 변수 또는 2FA 우회 granular 토큰. release-it hook은 대화형 OTP 입력을 받지 못한다.
- `GITHUB_TOKEN`(repo 권한).
- `main` 브랜치, 깨끗한 작업 트리.

## 17.7 검증

- `pnpm release:check`: 17.4의 1단계 검사 + `node scripts/pack-smoke.mjs` + `pnpm -r --filter "./packages/*" publish --dry-run --no-git-checks`. publish 없이 "배포 가능"을 판정하는 명령이다.
- `pnpm release --dry-run`: 설정 해석·bump 대상 6개·CHANGELOG 미리보기만 본다(hook은 실행되지 않는다). `main`이 아닌 브랜치에서는 `--git.requireBranch=<브랜치>`를 더한다.
- 17.2 규칙의 판정 함수는 testkit `pack-smoke-script.test.ts`가 L0로 고정한다(9.8.3).
