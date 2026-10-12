# userscript-vault

외부 유출 없는 개인용 사용자 스크립트 관리자. Tampermonkey 대체.

- 도메인(호스트명) 하나에 스크립트 여러 개. 서브도메인 포함 옵션.
- **자동 실행은 없다.** 스크립트는 저장만 되고, 해당 도메인 페이지를 연 뒤 툴바 팝업에서 **실행**을 눌러야 그때 현재 탭에 한 번 주입된다.
- 실행 world는 스크립트마다 선택: `USER_SCRIPT`(격리, 기본) / `MAIN`(페이지 전역 접근).
- MV3 `chrome.userScripts.execute`로 실행. Chrome 135+.
- 저장은 `chrome.storage.local`만. 네트워크 호출 0건, 동기화 없음.
- 전체 데이터를 zip(`export.json` + `도메인/스크립트.js`)으로 내보내기/가져오기.

## 설치

```sh
npm install
npm run build
```

`chrome://extensions` → 개발자 모드 → "압축해제된 확장 프로그램을 로드합니다" → `dist/` 선택 → 카드의 세부정보 → "사용자 스크립트 허용" 켜기.

## 개발

```sh
npm test              # vitest (lib 단위 테스트)
npm run build         # tsc + vite build → dist/
npm run check:privacy # 네트워크/sync 코드 없음 검사
npm run e2e           # Playwright: 실제 Chromium에 확장 로드, 로컬 서버 페이지에서 스크립트 실행까지 검증
```

E2E는 처음 한 번 `npx playwright install chromium`이 필요하다. Chrome 137+ 브랜드 빌드는 `--load-extension`을 무시하므로 Playwright 번들 Chromium을 쓴다. 네이티브 권한 프롬프트는 자동화할 수 없어 e2e 전용 빌드(`dist-e2e/`)에만 `host_permissions: ["<all_urls>"]`를 넣는다. 권한 프롬프트 흐름과 팝업의 실제 탭 매칭은 `docs/manual-qa.md`로 확인한다.

문서: `docs/superpowers/specs/` (설계), `docs/superpowers/plans/` (구현 플랜), `docs/manual-qa.md` (수동 QA).
