# @cp949/runo-xterm-readline

[strtok/xterm-readline](https://github.com/strtok/xterm-readline) 1.2.2의 `src/*.ts`를 벤더링한 workspace 패키지. `private`이며 npm에 배포하지 않는다. 결정 배경은 `docs/adr/0003-vendor-xterm-readline.md`.

## 출처

| 항목     | 값                                              |
| -------- | ----------------------------------------------- |
| 원본     | `strtok/xterm-readline`                         |
| 버전     | 1.2.2                                           |
| 커밋     | `8869f17542bed618d8f389fea46c000089a8d9ad`      |
| 라이선스 | MIT (`LICENSE-MIT`, Copyright 2021 Erik Bremen) |

`LICENSE-MIT`와 저작권 고지를 유지한다. 원본 소스의 영어 주석과 시험 제목은 업스트림 diff를 위해 번역하지 않는다.

## 원본 대비 변경

`highlight`·`keymap`·`vterm`은 원본과 바이트 동일하다. 변경은 `readline.ts`·`state.ts`·`tty.ts`·`history.ts`·`line.ts`·`index.ts`(신규)로 한정한다. 전체 변경 이력(파일·API·근거)은 `CHANGELOG.md`. 여기서는 종류만 묶는다.

- **옵션 추가**: `persist`(history를 localStorage에 안 남김), `skipBlankHistory`, `typeAhead`(기본 켜짐, 활성 읽기가 없을 때 들어온 입력을 버리지 않고 쌓아 다음 읽기가 받음), `cancelable` 읽기(Ctrl+C가 reject 대신 `resolve(null)`), `prefill`·`prefillCursor`, `history: false`(그 읽기는 history에 안 남음).
- **훅 추가**: `onKey`(키 하나마다, `true`면 벤더 처리 생략), `onKeyEvent`(모든 keydown/keypress/keyup, `true`면 xterm 기본 처리까지 생략), `historyEntry`(기록될 문자열 교체).
- **신규 API**: `getCursor`·`editInsert`·`editBackspace`(활성 읽기 없이도 현재 줄 조작), `getHistory`, `History.restore`, `printAbove`·`printAboveRaw`(읽기 위에 배경 출력), `takeRead`(열린 읽기를 제출 없이 가로챔), `isReading`·`hasPendingRead`·`abovePrefix`.
- **동작 수정**: `moveLineUp`이 도착 열 0·빈 도착 줄에서 도착 줄 처음으로 가도록 고침, `dispose()`가 대기 중인 읽기를 reject하도록 강화, `Tty.width()`의 CSI 파싱을 ECMA-48대로 고침(폭 오계산 버그), 재그리기 대기 로직을 `LineView`로 통합.
- **시험**: 원본 jest 8개를 vitest로 이식. 옵션·훅·신규 API마다 시험 파일 추가.
- **빌드·설정**: tsdown(ESM + d.ts), `noUncheckedIndexedAccess: false`·`tty.ts` 한정 lint 예외는 원본 코드 스타일을 그대로 두기 위함.

## 업스트림 추적

원격을 연결하지 않는다. 업스트림 변경은 원본 저장소(`strtok/xterm-readline`)의 `CHANGELOG.md` 버전 기준으로 수동 diff해 가져온다. 이 패키지 자체의 변경 이력은 위 "원본 대비 변경"이 가리키는 `CHANGELOG.md`(별개 파일)를 본다.

## 명령

```bash
pnpm --filter @cp949/runo-xterm-readline test
pnpm --filter @cp949/runo-xterm-readline build
```

`vterm.ts`는 시험 전용 헬퍼이며 빌드 진입점(`src/index.ts`)에서 export하지 않는다.
