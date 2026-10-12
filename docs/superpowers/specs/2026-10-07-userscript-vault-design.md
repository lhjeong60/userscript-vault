# userscript-vault 설계

> Tampermonkey 대체. 특정 도메인에서 실행할 사용자 스크립트를 관리·실행하는 크롬 확장. 외부로 어떤 데이터도 내보내지 않는다.

- 작성일: 2026-10-07
- 상태: 구현 완료.
- **현재 동작은 14장이 기준이다.** 1~13장은 "스크립트를 자동 실행(등록)한다"는 초기 모델을 전제로 쓰였고, 그 자동 실행은 14장에서 전부 제거됐다. 1~13장의 자동 실행·registry·background·`enabled`/`manualOnly`/`runAt`·`errors` 관련 서술은 모두 14장으로 대체된다. 저장소 구조·호스트 정규화·zip 가져오기/내보내기·도메인 권한·프라이버시 보장은 그대로 유효하다.

## 1. 목표와 비목표

### 목표

- 도메인(호스트명) 1 : 스크립트 N 구조로 사용자 스크립트를 등록·편집·on/off.
- 등록한 도메인의 페이지가 열리면 활성 스크립트를 자동 실행.
- 전체 데이터를 zip 파일로 내보내고, 같은 zip을 불러올 수 있다. zip 안에서 스크립트는 `도메인/스크립트명.js` 파일로 보인다.
- 확장 자체는 네트워크 호출 0건. 원격 저장소, 동기화, 텔레메트리, 원격 스크립트 로딩 전부 없음.
- 개인용. 스토어 배포 없이 `chrome://extensions`에서 unpacked 로드.

### 비목표 (지금 안 함)

- Tampermonkey 헤더(`// ==UserScript==`) 호환, `GM_*` API.
- 사용자 스크립트의 네트워크 요청 차단. 스크립트가 무엇을 하든 사용자 책임.
- 저장 데이터 암호화.
- 로컬 폴더 직접 읽기/쓰기(File System Access API). 외부 에디터 편집은 나중 과제.
- Firefox 등 다른 브라우저.
- 스크립트 간 공유 라이브러리, 의존성 관리, 자동 업데이트.

## 2. 핵심 결정과 이유

| 결정 | 선택 | 이유 |
|---|---|---|
| 실행 엔진 | MV3 `chrome.userScripts` | MV3에서 임의 코드 문자열을 페이지에 주입하는 유일한 공식 경로. `<script>` 태그 주입은 사이트 CSP에 막힘. Tampermonkey도 동일 API 사용 |
| 저장소 | `chrome.storage.local` + `unlimitedStorage` | 용량 제한 없음. 디스크 파일 직접 쓰기는 확장에서 불가 |
| 도메인 단위 | 호스트명 하나 + 서브도메인 포함 체크박스 | 사용자 멘탈 모델("이 사이트의 스크립트들")과 일치. 경로별 분기는 스크립트 안에서 `location.pathname` 검사 |
| 스크립트 포맷 | 순수 JS 본문, 메타데이터는 별도 JSON | 헤더 파서 불필요. 가져오기/내보내기는 자체 zip만 |
| UI | 팝업 + 옵션 페이지, Vanilla TS + Vite + CodeMirror 6 | 목록 2개와 에디터 1개. 프레임워크 불필요 |
| 호스트 권한 | `optional_host_permissions: ["<all_urls>"]`, 도메인 추가 시 해당 origin만 요청 | 등록한 도메인 외에는 확장이 어떤 페이지에도 접근 권한을 갖지 않음 |

## 3. 아키텍처

```
userscript-vault/
├── manifest.json
├── package.json
├── vite.config.ts                 @crxjs/vite-plugin, 엔트리: background, popup, options
├── src/
│   ├── background.ts              서비스 워커. storage 변경 → userScripts 재동기화
│   ├── popup/
│   │   ├── popup.html
│   │   ├── popup.ts               현재 탭 호스트의 스크립트 on/off
│   │   └── popup.css
│   ├── options/
│   │   ├── options.html
│   │   ├── options.ts             도메인 목록 + 스크립트 목록 + 에디터 + 가져오기/내보내기
│   │   ├── editor.ts              CodeMirror 6 래퍼
│   │   └── options.css
│   └── lib/
│       ├── types.ts               Domain, ScriptMeta, ExportManifest
│       ├── storage.ts             storage.local 접근 유일 지점
│       ├── host.ts                호스트명 정규화·검증
│       ├── patterns.ts            Domain → match pattern 배열
│       ├── registry.ts            storage 상태 → userScripts 등록 목록 계산
│       ├── archive.ts             zip 생성/파싱 (fflate)
│       └── validate.ts            JS 문법 사전 검사 (lezer 파스 트리의 오류 노드 탐색)
├── tests/                         vitest, lib/ 단위 테스트
└── docs/
```

### manifest.json 요지

```json
{
  "manifest_version": 3,
  "name": "userscript-vault",
  "version": "0.1.0",
  "minimum_chrome_version": "120",
  "permissions": ["userScripts", "storage", "unlimitedStorage", "activeTab"],
  "optional_host_permissions": ["<all_urls>"],
  "background": { "service_worker": "src/background.ts", "type": "module" },
  "action": { "default_popup": "src/popup/popup.html" },
  "options_page": "src/options/options.html"
}
```

`host_permissions`는 비워 둔다. 네트워크 관련 권한, `storage.sync`, 외부 URL 참조는 어디에도 없다.

### 역할 경계

- **background.ts**: `chrome.userScripts`를 호출하는 유일한 모듈. `storage.onChanged`와 `runtime.onInstalled`를 듣고 재동기화. UI 로직 없음.
- **popup / options**: `lib/storage.ts`만 통해 데이터를 읽고 쓴다. 실행 엔진을 직접 건드리지 않는다. storage에 쓰면 background가 알아서 반영.
- **lib/**: 크롬 API 의존을 `storage.ts` 한 곳으로 모은다. 나머지 모듈은 순수 함수라 vitest로 그대로 테스트.

### 의존성

- `codemirror` + `@codemirror/lang-javascript` + `@codemirror/theme-one-dark` (에디터, 다크 모드 테마)
- `fflate` (zip)
- `@crxjs/vite-plugin`, `vite`, `typescript`, `vitest` (개발)

이 외 추가 금지. 특히 런타임에 외부 리소스를 로드하는 패키지는 넣지 않는다.

## 4. 데이터 모델

### storage.local 키

| 키 | 값 | 설명 |
|---|---|---|
| `meta` | `{ schemaVersion: 1 }` | 마이그레이션 훅 |
| `errors` | `Record<domainId, string>` | background가 기록한 등록 실패 사유. options 배너용. 성공하면 비움 |
| `domains` | `Record<domainId, Domain>` | 도메인 인덱스. 팝업이 읽는 건 이것과 해당 도메인의 scripts뿐 |
| `scripts:<domainId>` | `Record<scriptId, ScriptMeta>` | 도메인별 스크립트 메타 묶음 |
| `code:<scriptId>` | `string` | 스크립트 본문. 에디터 열 때와 background 동기화 때만 읽음 |

### 타입

```ts
interface Domain {
  id: string;               // crypto.randomUUID()
  host: string;             // "github.com". 소문자, scheme/port/path 없음
  includeSubdomains: boolean;
  enabled: boolean;         // 도메인 전체 on/off
  createdAt: number;
}

type RunAt = "document_start" | "document_end" | "document_idle";
type World = "USER_SCRIPT" | "MAIN";

interface ScriptMeta {
  id: string;
  domainId: string;
  name: string;             // 사용자가 지은 이름. 내보내기 파일명의 원본
  enabled: boolean;
  runAt: RunAt;             // 기본 "document_idle"
  world: World;             // 기본 "USER_SCRIPT"
  updatedAt: number;
}
```

### 규칙

- 스크립트 실효 상태 = `domain.enabled && script.enabled`.
- 호스트 정규화: 입력값을 `new URL(input.includes("://") ? input : "https://" + input)`로 파싱해 `hostname`만 취한다. 소문자. 빈 값, 공백 포함, IP 주소가 아닌데 점이 없는 값(`localhost` 제외)은 거부. 같은 host가 이미 있으면 거부.
- 도메인 삭제: `scripts:<id>` 키와 하위 모든 `code:<scriptId>` 키를 `storage.local.remove([...])` 한 번으로 먼저 지우고, 그다음 `domains`에서 제거. 중간에 끊겨도 고아 code 키가 아니라 빈 도메인이 남는다.
- 스크립트 이동(다른 도메인으로)은 지원하지 않는다. 복사해서 새로 만든다.
- 모든 쓰기는 `lib/storage.ts`의 함수를 통한다. 함수는 새 객체를 만들어 저장하고, 바뀐 키만 `storage.local.set`한다. `chrome.storage.sync`는 코드베이스 어디에도 등장하지 않는다 (CI/테스트에서 grep으로 검증).
- `world: "MAIN"`은 페이지의 전역 변수에 접근해야 할 때만 사용자가 명시적으로 선택. 기본은 격리된 `USER_SCRIPT`.

## 5. 실행 엔진 (background)

### match pattern 생성 (`lib/patterns.ts`)

```ts
function patternsFor(domain: Domain): string[] {
  const base = [`*://${domain.host}/*`];
  return domain.includeSubdomains ? [...base, `*://*.${domain.host}/*`] : base;
}
```

`http`와 `https` 둘 다 매칭한다. `file://`, `chrome://`는 대상 아님.

### 등록 목록 계산 (`lib/registry.ts`)

순수 함수. 입력은 storage 전체 스냅샷, 출력은 `chrome.userScripts.register`에 넘길 배열.

```ts
interface RegisteredUserScript {
  id: string;        // scriptId 그대로
  matches: string[];
  js: [{ code: string }];
  runAt: RunAt;
  world: World;
}

interface RegistrationGroup {
  domainId: string;
  registrations: RegisteredUserScript[];
}

function buildRegistrations(
  snapshot: StorageSnapshot,
  grantedOrigins: string[],
): { groups: RegistrationGroup[]; missingPermission: string[] }
```

도메인 단위로 묶어 반환하는 이유: 일괄 등록이 실패했을 때 도메인별로 다시 등록해 실패한 도메인만 제외하기 위해 (8장).

- `domain.enabled && script.enabled`인 것만 포함.
- 본문이 빈 문자열이면 제외.
- 호스트 권한이 없는 도메인은 제외하고, 그 도메인 id를 `missingPermission` 목록으로 함께 반환 → options에서 경고 표시.

### 동기화 전략

전체 교체. 변경 종류를 따지지 않는다.

```ts
async function resync() {
  const snapshot = await readAll();
  const granted = await chrome.permissions.getAll();
  const { groups, missingPermission } = buildRegistrations(snapshot, granted.origins ?? []);
  await chrome.userScripts.unregister();          // 인자 없으면 전체 해제
  const all = groups.flatMap(g => g.registrations);
  if (all.length) await chrome.userScripts.register(all);
  // 실패 시 도메인 단위 재시도, missingPermission과 함께 errors 키에 기록 (8장)
}
```

- 트리거: `runtime.onInstalled` (확장 설치·업데이트·리로드 시 등록이 사라지므로 필수), `storage.onChanged` (100ms 디바운스), `permissions.onAdded/onRemoved`.
- `storage.onChanged`는 키마다 따로 발화하므로 디바운스 없이는 한 번 저장에 여러 번 재등록된다.
- 스크립트 수백 개까지는 전체 교체가 문제 없다. 차분 등록은 필요해질 때.
- 등록은 새로 열리는 페이지부터 적용된다. 이미 열린 탭은 새로고침해야 한다. 옵션 페이지 저장 시 이 사실을 안내 문구로 표시.

### userScripts API 사용 불가 상황

`chrome.userScripts`는 사용자가 확장 상세 페이지에서 "사용자 스크립트 허용"(Chrome 138 미만은 개발자 모드)을 켜기 전까지 `undefined`다.

- background: `resync` 진입 시 `typeof chrome.userScripts === "undefined"`면 조용히 종료.
- popup / options: 같은 검사를 하고 상단에 배너 표시. "`chrome://extensions` → userscript-vault 세부정보 → 사용자 스크립트 허용 켜기". 배너 외 UI는 정상 동작(스크립트 편집·저장은 가능).

### 호스트 권한 흐름

1. 사용자가 options에서 호스트 입력 후 "추가" 클릭.
2. `chrome.permissions.request({ origins: patternsFor(domain) })` 호출. 사용자 제스처 안에서 실행되어야 하므로 클릭 핸들러에서 직접 호출.
3. 거부되면 도메인을 만들지 않고 "권한이 필요합니다" 표시.
4. 허용되면 `storage`에 도메인 저장 → `storage.onChanged` → resync.
5. `includeSubdomains`를 나중에 켜면 `*://*.host/*` 권한을 그때 추가 요청. 거부되면 체크박스 원복.
6. 도메인 삭제 시 `chrome.permissions.remove`로 권한도 반납.

## 6. UI

### 팝업

- 현재 탭의 URL에서 호스트를 얻는다 (`chrome.tabs.query({active:true,currentWindow:true})`, `activeTab`으로 URL 접근).
- 호스트가 등록된 도메인과 매칭되는지 확인 (정확 일치, 또는 `includeSubdomains`인 도메인의 서브도메인).
- 매칭 도메인 있음: 도메인 토글 + 스크립트별 토글 목록. 토글은 즉시 storage에 반영. 하단에 "관리 열기"(options 페이지).
- 매칭 도메인 없음: "이 사이트에 스크립트 없음" + "이 도메인 추가" 버튼. 버튼은 options 페이지를 `?add=<host>` 쿼리로 연다 (권한 요청은 options에서).
- `chrome://`, 새 탭 등 URL 없는 탭: "여기서는 사용할 수 없음".
- 팝업은 `code:*` 키를 읽지 않는다.

### 옵션 페이지

3단 레이아웃.

```
┌──────────────┬──────────────────┬──────────────────────────────┐
│ 도메인 목록   │ 스크립트 목록      │ 에디터                         │
│ + 추가        │ + 새 스크립트      │ [이름] [runAt ▾] [world ▾] [저장] │
│ github.com ● │ dark-fix      ●  │                              │
│ naver.com  ○ │ hide-ads      ○  │  CodeMirror 6                │
│              │                  │                              │
│ 가져오기 내보내기│                  │ 상태줄: 저장됨 / 문법 오류 / 탭 새로고침 필요 │
└──────────────┴──────────────────┴──────────────────────────────┘
```

- 도메인 선택 → 가운데 목록 갱신. 스크립트 선택 → `code:<id>` 읽어 에디터에 로드.
- 저장: `Cmd/Ctrl+S` 또는 버튼. 저장 전 `validate.ts`로 문법 검사. MV3 확장 페이지는 CSP가 `eval`/`new Function`을 막으므로, 이미 쓰는 `@codemirror/lang-javascript`의 lezer 파서로 트리를 만들고 오류 노드(`type.isError`)를 찾는다. 오류면 저장은 하되 상태줄에 "문법 오류: 줄 N" 표시 (저장을 막으면 작업 중 코드를 잃을 수 있음).
- 저장 안 한 변경이 있는데 다른 스크립트로 이동하면 확인 대화상자(페이지 내 모달, `confirm()` 아님).
- 도메인 편집: 서브도메인 포함 체크박스, 삭제(하위 스크립트 수를 보여주고 확인).
- 스크립트 삭제, 이름 변경, 다른 도메인으로 복사.
- 상단 배너 영역: userScripts 비활성, 호스트 권한 누락 도메인.

### 디자인 방향

개발 도구. 장식 최소, 정보 밀도 높게.

- 시스템 테마 따름 (`prefers-color-scheme`). 라이트/다크 둘 다 토큰으로 정의.
- 모노스페이스 폰트를 에디터뿐 아니라 도메인·스크립트 이름에도 사용해 "파일 트리" 인상.
- 색은 상태 표현에만: 활성(초록 점), 비활성(회색 점), 오류(빨강), 권한 필요(주황).
- 외부 폰트 로드 없음. 시스템 모노스페이스 스택.

## 7. 가져오기 / 내보내기

### zip 구조

```
userscript-vault-2026-10-07.zip
├── export.json
├── github.com/
│   ├── dark-fix.js
│   └── hide-ads.js
└── naver.com/
    └── clean-feed.js
```

### export.json

```ts
interface ExportManifest {
  schemaVersion: 1;
  exportedAt: string;             // ISO 8601
  domains: Array<{
    host: string;
    includeSubdomains: boolean;
    enabled: boolean;
    scripts: Array<{
      name: string;
      file: string;               // zip 안 경로. "github.com/dark-fix.js"
      enabled: boolean;
      runAt: RunAt;
      world: World;
    }>;
  }>;
}
```

- id는 내보내지 않는다. 가져올 때 새로 발급.
- 파일명: `name`에서 `/ \ : * ? " < > |`와 제어문자를 `_`로 치환, 앞뒤 공백·점 제거, 빈 값이면 `script`. 같은 도메인 안에서 중복되면 `-2`, `-3` 접미사. 메타의 `name`은 원본 유지, `file`이 실제 경로.
- 내보내기는 options 페이지에서 `Blob` → `URL.createObjectURL` → `<a download>` 클릭. 확장 페이지에서는 허용된다.
- 가져오기는 `<input type="file" accept=".zip">`.

### 가져오기 규칙

1. zip 파싱. `export.json` 없거나 `schemaVersion`이 지원 범위 밖이면 거부하고 이유 표시.
2. 각 `file`이 zip에 실제로 있는지 확인. 없으면 그 스크립트만 건너뛰고 결과 요약에 기록.
3. 도메인은 `host`로 기존과 매칭. 있으면 기존 도메인에 합치고(`includeSubdomains`, `enabled`는 기존 값 유지), 없으면 새로 만든다. 새 도메인은 호스트 권한 요청이 필요하므로, 가져오기 버튼 클릭 핸들러 안에서 새 도메인 전체의 origins를 한 번에 `permissions.request`한다. 거부되면 가져오기 전체를 중단한다 (부분 적용 없음).
4. 스크립트는 같은 도메인 안에서 `name`으로 기존과 매칭. 충돌 시 정책은 가져오기 시작 전 사용자가 한 번 선택: **덮어쓰기** 또는 **건너뛰기**. 덮어쓰기는 본문·runAt·world·enabled를 교체하고 id는 유지.
5. 끝나면 요약 표시: 추가 N, 덮어쓴 N, 건너뛴 N, 오류 N.
6. 모든 storage 쓰기를 모아 `storage.local.set` 한 번으로 적용. 중간 실패 시 아무것도 반영되지 않는다.

## 8. 오류 처리

| 상황 | 처리 |
|---|---|
| `chrome.userScripts` 없음 | background 조용히 종료. UI 배너로 켜는 법 안내 |
| `userScripts.register` 실패 (잘못된 패턴, 권한 부족) | 일괄 등록이 실패하면 도메인 단위로 나눠 다시 등록해 실패한 도메인만 제외. 실패 도메인 id와 사유를 `storage.local`의 `errors` 키에 기록 → options 배너에 표시 |
| 호스트 권한 거부 | 도메인 생성 안 함. 인라인 메시지 |
| 스크립트 문법 오류 | 저장은 허용. 상태줄에 표시. 등록은 그대로 하되 페이지에서 실행 실패하면 사이트 콘솔에 남음 |
| 가져오기 zip 손상 | 거부, 사유 표시. storage 변경 없음 |
| storage 쓰기 실패 (QuotaExceeded 등) | UI에 오류 표시, 메모리 상태는 되돌림 |
| 팝업에서 탭 URL 못 읽음 | "여기서는 사용할 수 없음" |

`console.error`는 background에서만, 사용자 데이터(스크립트 본문)는 로그에 남기지 않는다.

## 9. 보안·프라이버시 보장

구현이 끝나면 아래를 체크리스트로 검증한다.

- [ ] `manifest.json`에 `host_permissions` 없음. `optional_host_permissions`만.
- [ ] 코드베이스 전체 `grep -r "storage.sync\|fetch(\|XMLHttpRequest\|WebSocket\|navigator.sendBeacon" src/` 결과 0건.
- [ ] 빌드 산출물에 외부 URL(`http://`, `https://`) 문자열이 없음 (match pattern의 `*://` 제외).
- [ ] 외부 폰트·CDN 스크립트 로드 없음. 모든 에셋은 번들.
- [ ] 크롬 DevTools Network 탭에서 확장 서비스 워커와 options 페이지의 요청이 0건.
- [ ] 등록되지 않은 도메인에서 `chrome.permissions.contains` 결과 false.

## 10. 테스트

### 단위 (vitest, `tests/`)

- `host.ts`: 정규화 케이스 (대문자, scheme 포함, 경로 포함, 포트, 공백, 빈 값, IP, localhost, 중복).
- `patterns.ts`: 서브도메인 on/off.
- `registry.ts`: enabled 조합, 빈 본문 제외, 권한 없는 도메인 분리.
- `archive.ts`: 내보내기 → 가져오기 왕복 동일성, 파일명 치환, 중복 접미사, `export.json` 누락, 파일 누락.
- `storage.ts`: `chrome.storage.local` 인메모리 가짜 객체로 도메인 삭제 시 하위 키 전부 제거, 바뀐 키만 set.
- `validate.ts`: 정상 코드, 문법 오류 줄 번호.

### 수동 체크리스트 (`docs/manual-qa.md`)

- 설치 → 사용자 스크립트 허용 토글 → 배너 사라짐.
- 도메인 추가 → 권한 프롬프트 → 스크립트 작성 → 저장 → 탭 새로고침 → 실행 확인.
- 도메인 off → 새로고침 → 실행 안 됨. 스크립트 off도 동일.
- 서브도메인 체크 → 추가 권한 프롬프트 → `sub.host`에서 실행.
- `world: MAIN`에서 페이지 전역 변수 접근 확인.
- 확장 리로드 → 스크립트 여전히 실행 (onInstalled 재동기화).
- 내보내기 → 확장 삭제·재설치 → 가져오기 → 동일 동작.
- 9장 보안 체크리스트.

E2E 자동화(Playwright + 확장 로드)는 수동 체크리스트가 반복적으로 귀찮아질 때 추가.

## 11. 사전 검증 (spike)

구현 플랜 첫 태스크로 수행. 결과에 따라 설계 일부가 단순해질 수 있다.

1. ~~**`userScripts.register`가 호스트 권한을 요구하는가.**~~ 확인 완료 (2026-10-07, Chrome 공식 문서): 요구한다. 설계 그대로.
2. **`@crxjs/vite-plugin`이 `userScripts` 권한과 `options_page`를 현재 Vite 버전에서 문제없이 처리하는가.** 안 되면 플러그인 없이 Vite 멀티 엔트리 + manifest 복사로 대체.

## 12. 나중 과제

- 로컬 폴더 연결(File System Access API)로 외부 에디터 편집 반영.
- 차분 등록 (스크립트가 수백 개를 넘을 때).
- 스크립트별 `excludeMatches`, 경로 필터.
- Playwright E2E.
- 키보드 단축키로 현재 도메인 스크립트 일괄 토글.

## 13. 변경 이력 — 2026-10-08 UI 개편

사용자 피드백("자동 실행은 원할 때만", "스코프 불명확", "경계 안 보임") 반영. 4~7장과 다른 부분은 이 장이 우선한다.

- **자동 실행 opt-in.** 새 스크립트는 `enabled: false`로 생성. 스크립트 목록·에디터 헤더·팝업의 "자동 실행" 스위치로 켠다. 꺼진 스크립트는 팝업의 **실행** 버튼으로 현재 탭에 한 번만 적용 (`chrome.userScripts.execute`, Chrome 135+. 없으면 버튼 비활성).
- **수동 전용 잠금.** `ScriptMeta.manualOnly: true`인 스크립트는 registry가 절대 등록하지 않는다(`enabled` 무시). 자동 실행으로는 결코 뜨지 않고 팝업 **실행** 버튼으로만 주입된다. 에디터 헤더 "수동 전용" 체크박스로 전환하며, 켜면 자동 실행 스위치가 잠기고 함께 꺼진다. 목록·팝업에서는 스위치 대신 "수동" 배지. 인증 토큰 주입처럼 페이지 로드마다 자동 실행되면 위험한 스크립트를 위한 안전장치. zip에도 `manualOnly`가 포함되어 왕복 보존된다.
- **스코프 분리.** 도메인 영역 = 추가·편집(호스트/서브도메인)·삭제, 전부 도메인 대화상자에서. 스크립트 영역 = 새로 만들기·삭제·선택·자동 실행 스위치. 에디터 = 이름·실행 시점·world·본문 수정과 저장. "복사" 기능 제거.
- **단계별 노출.** `data-stage`: 도메인 없음 → 온보딩 카드만. 도메인 선택 전 → 도메인 목록만. 도메인 선택 → 스크립트 패널. 스크립트 선택 → 에디터 패널.
- **시인성.** 패널 3단은 배경 밝기 단계(`--bg-0/1/2`) + 진한 경계(`--border`) + 헤더 바. 선택 항목은 좌측 3px 액센트 바 + 틴트 배경. 에디터는 다크 모드에서 `@codemirror/theme-one-dark`.
- **호스트 편집.** `updateDomain`이 `host` 변경을 받음(중복 거부). 권한은 새 패턴 요청 후 더 이상 안 쓰는 패턴만 반납. 반납 실패(필수 권한, 더 넓은 권한에 포함)는 무시.
- **가져오기 결과**는 에디터가 닫혀 있으면 상태줄 대신 배너에 6초 표시.

## 14. 변경 이력 — 2026-10-08 자동 실행 제거 (현재 기준)

사용자 결정: "자동 실행은 아예 안 되게." 등록(자동 실행) 개념을 코드에서 완전히 들어냈다. 이 장이 1~13장의 자동 실행 관련 서술을 대체한다.

### 모델
- 스크립트는 **자동 실행되지 않는다.** 페이지 로드·새로고침·확장 재기동 어떤 경로로도 뜨지 않는다.
- 유일한 실행 경로: 해당 도메인 페이지를 연 뒤 **툴바 팝업의 "실행" 버튼** → `chrome.userScripts.execute`로 현재 탭에 1회 주입. 사용자 클릭(제스처)이 있어야만 실행된다.
- 실행 world는 스크립트마다 선택(`USER_SCRIPT` 기본 / `MAIN`). execute는 `injectImmediately: true`로 호출하므로 `runAt` 개념은 없다.

### 제거된 것
- `src/lib/registry.ts`, `src/background.ts`, `src/lib/serial.ts` 파일 삭제.
- manifest의 `background` 항목 삭제. 백그라운드 서비스워커 없음. `minimum_chrome_version` 135 (execute 요구).
- `ScriptMeta`에서 `enabled`, `manualOnly`, `runAt` 삭제. `Domain`에서 `enabled` 삭제. `RunAt` 타입·`RUN_AT_VALUES` 삭제.
- `StorageSnapshot.errors`, `storage.setErrors`/`readErrors` 삭제(등록 실패가 없으니 에러 키도 없음).
- `storage.onChanged` → userScripts 재등록 로직 전체 삭제.
- UI에서 자동 실행 스위치·수동 전용 체크박스·실행 시점 드롭다운·"수동" 배지 전부 삭제.

### 남은 타입
```ts
interface Domain { id; host; includeSubdomains; createdAt; }
interface ScriptMeta { id; domainId; name; world: "USER_SCRIPT" | "MAIN"; updatedAt; }
```

### 배너
`chrome.userScripts` 또는 `chrome.userScripts.execute`가 없으면(토글 꺼짐) 옵션·팝업 상단에 "사용자 스크립트 허용" 안내 배너. 등록 실패 배너는 없음(등록 자체가 없음).

### 검증
- 단위(vitest): host·patterns·storage·archive·validate. registry/serial 테스트 삭제.
- e2e(Playwright): 백그라운드가 없으므로 확장 컨텍스트는 상시 열어 둔 옵션 페이지에서 `chrome.*`를 evaluate. execute 경로를 실제 탭에 대해 검증(USER_SCRIPT 격리, MAIN 전역 접근), 저장만으로는 `getScripts()` 0건·페이지 로드 미실행을 함께 검증.
