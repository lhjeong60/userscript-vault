# userscript-vault 구현 플랜

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 외부 유출 없는 개인용 Tampermonkey 대체 크롬 확장. 도메인별 사용자 스크립트를 저장·실행하고 zip으로 가져오기/내보내기한다.

**Architecture:** `chrome.storage.local`이 유일한 원본. background 서비스 워커가 storage 변경을 듣고 `chrome.userScripts`에 전체 재등록한다. popup/options는 storage만 읽고 쓴다. `src/lib/`는 크롬 API 의존을 `storage.ts` 하나에 가두고 나머지는 순수 함수로 두어 vitest로 테스트한다.

**Tech Stack:** TypeScript, Vite 8 + @crxjs/vite-plugin 3, CodeMirror 6, fflate, vitest 5. 프레임워크 없음.

**Spec:** `userscript-vault/docs/superpowers/specs/2026-10-07-userscript-vault-design.md`

## Global Constraints

- 모든 경로는 `idea-bank/userscript-vault/` 기준. 명령은 그 디렉토리에서 실행.
- Node 22 이상. Chrome 120 이상 (`minimum_chrome_version: "120"`).
- 런타임 의존성은 `codemirror`, `@codemirror/lang-javascript`, `@codemirror/state`, `@codemirror/view`, `fflate`뿐. 추가 금지.
- `src/`에 `storage.sync`, `fetch(`, `XMLHttpRequest`, `WebSocket`, `sendBeacon` 문자열이 등장하면 안 된다 (Task 13의 `check:privacy`가 실패시킴).
- `manifest.json`에 `host_permissions` 없음. `optional_host_permissions: ["<all_urls>"]`만.
- `chrome.userScripts`는 `src/background.ts`에서만 호출. `chrome.storage`는 `src/lib/storage.ts`에서만 호출 (`onChanged` 리스너 등록은 예외).
- 사용자 데이터를 DOM에 넣을 때 `innerHTML` 금지. `textContent` 또는 `src/lib/dom.ts`의 `el()`만.
- UI 문구는 한국어.
- 모든 storage 쓰기는 새 객체를 만들어 저장한다. 기존 객체 필드를 직접 바꾸지 않는다.
- 커밋 메시지는 `<type>: <설명>` 한국어. 끝에 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. 호스트 입력에 포트가 섞임 (`localhost:3000`, `example.com:8080`) → 포트를 떼고 호스트명만 저장되어야 한다. (Task 2 테스트)
2. 스크립트 이름이 전부 파일명 금지 문자이거나 두 스크립트가 같은 안전 파일명으로 수렴 (`a/b`와 `a_b`) → 내보내기가 실패하거나 파일이 덮어써지면 안 된다. `script`, `a_b`, `a_b-2`로 분리. (Task 8 테스트)
3. background가 `errors` 키를 쓰면 `storage.onChanged`가 다시 발화한다 → 무한 재동기화 루프가 되면 안 된다. (Task 5의 `shouldResync` 테스트)
4. 도메인 `enabled: false`인데 스크립트는 `enabled: true` → 등록되면 안 된다. 반대도 마찬가지. (Task 5 테스트)
5. 가져오기 zip의 `export.json`이 가리키는 파일이 zip에 없거나 `runAt`/`world`에 알 수 없는 값 → 그 스크립트만 건너뛰거나 기본값으로 보정, 전체 가져오기는 계속. (Task 8 테스트)

---

### Task 1: 프로젝트 스캐폴드와 빌드 확인

spec 11장의 spike 2 포함. 빌드가 manifest·엔트리 3개를 올바르게 내보내는지 확인하고, 확장이 크롬에 로드되는지 본다.

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `manifest.json`, `.gitignore`
- Create: `src/background.ts`, `src/popup/popup.html`, `src/popup/popup.ts`, `src/options/options.html`, `src/options/options.ts`
- Create: `tests/smoke.test.ts`

**Interfaces:**
- Produces: 빌드 명령 `npm run build` → `dist/`. 테스트 명령 `npm test`.

- [ ] **Step 1: package.json 작성**

```json
{
  "name": "userscript-vault",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "test": "vitest run",
    "test:watch": "vitest",
    "check:privacy": "sh scripts/check-privacy.sh"
  },
  "dependencies": {
    "@codemirror/lang-javascript": "^6.2.5",
    "@codemirror/state": "^6.7.6",
    "@codemirror/view": "^6.43.13",
    "codemirror": "^6.0.2",
    "fflate": "^0.8.3"
  },
  "devDependencies": {
    "@crxjs/vite-plugin": "^3.0.0",
    "@types/chrome": "^0.3.4",
    "typescript": "^5.9.0",
    "vite": "^8.3.3",
    "vitest": "^5.0.3"
  }
}
```

- [ ] **Step 2: tsconfig.json, vite.config.ts, vitest.config.ts, .gitignore 작성**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["chrome", "vite/client"]
  },
  "include": ["src", "tests", "vite.config.ts", "vitest.config.ts"]
}
```

`vite.config.ts`:
```ts
import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.json";

export default defineConfig({
  plugins: [crx({ manifest })],
  build: { target: "chrome120", sourcemap: false },
});
```

`vitest.config.ts` (crx 플러그인 없이 lib만 테스트):
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], environment: "node" },
});
```

`.gitignore`:
```
node_modules/
dist/
```

- [ ] **Step 3: manifest.json 작성**

```json
{
  "manifest_version": 3,
  "name": "userscript-vault",
  "description": "외부 유출 없는 개인용 사용자 스크립트 관리자",
  "version": "0.1.0",
  "minimum_chrome_version": "120",
  "permissions": ["userScripts", "storage", "unlimitedStorage", "activeTab"],
  "optional_host_permissions": ["<all_urls>"],
  "background": { "service_worker": "src/background.ts", "type": "module" },
  "action": { "default_popup": "src/popup/popup.html", "default_title": "userscript-vault" },
  "options_page": "src/options/options.html"
}
```

- [ ] **Step 4: 엔트리 3개를 최소 내용으로 작성**

`src/background.ts`:
```ts
chrome.runtime.onInstalled.addListener(() => {
  console.log("userscript-vault installed");
});
```

`src/popup/popup.html`:
```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <title>userscript-vault</title>
  </head>
  <body>
    <p>popup</p>
    <script type="module" src="./popup.ts"></script>
  </body>
</html>
```

`src/popup/popup.ts`:
```ts
console.log("popup");
```

`src/options/options.html`:
```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <title>userscript-vault</title>
  </head>
  <body>
    <p>options</p>
    <script type="module" src="./options.ts"></script>
  </body>
</html>
```

`src/options/options.ts`:
```ts
console.log("options");
```

- [ ] **Step 5: 스모크 테스트 작성**

`tests/smoke.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import manifest from "../manifest.json";

describe("manifest", () => {
  it("has no static host_permissions", () => {
    expect("host_permissions" in manifest).toBe(false);
    expect(manifest.optional_host_permissions).toEqual(["<all_urls>"]);
  });
  it("declares required permissions", () => {
    expect(manifest.permissions).toEqual(
      expect.arrayContaining(["userScripts", "storage", "unlimitedStorage", "activeTab"]),
    );
  });
});
```

- [ ] **Step 6: 설치·테스트·빌드**

Run: `npm install && npm test && npm run build`
Expected: 테스트 2개 PASS. `dist/manifest.json` 존재. `ls dist/src/options` 에 `options.html` 존재. `ls dist/src/popup` 에 `popup.html` 존재. `dist/manifest.json`의 `background.service_worker`가 `.js` 파일을 가리킴.

빌드가 `userScripts` 권한이나 `options_page`로 실패하면: crx 플러그인을 빼고 `build.rollupOptions.input`에 html 2개 + `src/background.ts`를 넣고, `manifest.json`을 `public/`으로 옮겨 그대로 복사하는 방식으로 대체한다. 이 경우 manifest의 경로를 빌드 산출물 경로로 바꾼다.

- [ ] **Step 7: 크롬에 로드 확인 (수동)**

`chrome://extensions` → 개발자 모드 → "압축해제된 확장 프로그램을 로드합니다" → `dist/` 선택. 오류 없이 카드가 생기고, 아이콘 클릭 시 "popup" 텍스트, 세부정보 → 확장 프로그램 옵션 클릭 시 "options" 텍스트가 보이면 OK.

- [ ] **Step 8: 커밋**

```bash
git add userscript-vault
git commit -m "chore: userscript-vault 스캐폴드 (vite + crxjs + vitest)"
```

---

### Task 2: 타입과 호스트 정규화

**Files:**
- Create: `src/lib/types.ts`, `src/lib/host.ts`
- Test: `tests/host.test.ts`

**Interfaces:**
- Produces:
  - `types.ts`: `RunAt`, `World`, `RUN_AT_VALUES`, `WORLD_VALUES`, `Domain`, `ScriptMeta`, `StorageSnapshot`, `SCHEMA_VERSION`, `ExportManifest`
  - `host.ts`: `normalizeHost(input: string): HostResult` where `HostResult = { ok: true; host: string } | { ok: false; error: "empty" | "invalid" }`

- [ ] **Step 1: types.ts 작성**

```ts
export type RunAt = "document_start" | "document_end" | "document_idle";
export type World = "USER_SCRIPT" | "MAIN";

export const RUN_AT_VALUES: readonly RunAt[] = ["document_start", "document_end", "document_idle"];
export const WORLD_VALUES: readonly World[] = ["USER_SCRIPT", "MAIN"];

export interface Domain {
  id: string;
  host: string;
  includeSubdomains: boolean;
  enabled: boolean;
  createdAt: number;
}

export interface ScriptMeta {
  id: string;
  domainId: string;
  name: string;
  enabled: boolean;
  runAt: RunAt;
  world: World;
  updatedAt: number;
}

export interface StorageSnapshot {
  domains: Record<string, Domain>;
  scripts: Record<string, Record<string, ScriptMeta>>; // domainId → scriptId → meta
  code: Record<string, string>; // scriptId → 본문
  errors: Record<string, string>; // domainId → 등록 실패 사유
}

export const SCHEMA_VERSION = 1 as const;

export interface ExportManifest {
  schemaVersion: typeof SCHEMA_VERSION;
  exportedAt: string;
  domains: Array<{
    host: string;
    includeSubdomains: boolean;
    enabled: boolean;
    scripts: Array<{
      name: string;
      file: string;
      enabled: boolean;
      runAt: RunAt;
      world: World;
    }>;
  }>;
}
```

- [ ] **Step 2: 실패하는 테스트 작성**

`tests/host.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { normalizeHost } from "../src/lib/host";

describe("normalizeHost", () => {
  it.each([
    ["github.com", "github.com"],
    ["  GitHub.COM  ", "github.com"],
    ["https://github.com/foo/bar?x=1", "github.com"],
    ["http://Example.com:8080/path", "example.com"],
    ["localhost:3000", "localhost"],
    ["localhost", "localhost"],
    ["127.0.0.1", "127.0.0.1"],
    ["sub.domain.co.kr", "sub.domain.co.kr"],
  ])("normalizes %j → %j", (input, host) => {
    expect(normalizeHost(input)).toEqual({ ok: true, host });
  });

  it("rejects empty input", () => {
    expect(normalizeHost("")).toEqual({ ok: false, error: "empty" });
    expect(normalizeHost("   ")).toEqual({ ok: false, error: "empty" });
  });

  it.each(["git hub.com", "nodots", "https://", "://x", "a b"])("rejects %j", (input) => {
    expect(normalizeHost(input)).toEqual({ ok: false, error: "invalid" });
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `npx vitest run tests/host.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/host'`

- [ ] **Step 4: host.ts 구현**

```ts
export type HostResult = { ok: true; host: string } | { ok: false; error: "empty" | "invalid" };

export function normalizeHost(input: string): HostResult {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: "empty" };
  if (/\s/.test(trimmed)) return { ok: false, error: "invalid" };

  let hostname: string;
  try {
    hostname = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname.toLowerCase();
  } catch {
    return { ok: false, error: "invalid" };
  }
  if (!hostname) return { ok: false, error: "invalid" };

  const isIpv6 = hostname.startsWith("[");
  if (!hostname.includes(".") && hostname !== "localhost" && !isIpv6) {
    return { ok: false, error: "invalid" };
  }
  return { ok: true, host: hostname };
}
```

- [ ] **Step 5: 통과 확인**

Run: `npx vitest run tests/host.test.ts`
Expected: PASS (전부)

- [ ] **Step 6: 커밋**

```bash
git add userscript-vault/src/lib/types.ts userscript-vault/src/lib/host.ts userscript-vault/tests/host.test.ts
git commit -m "feat: 데이터 타입과 호스트 정규화"
```

---

### Task 3: match pattern 생성과 호스트 매칭

**Files:**
- Create: `src/lib/patterns.ts`
- Test: `tests/patterns.test.ts`

**Interfaces:**
- Consumes: `Domain` (Task 2)
- Produces:
  - `patternsFor(domain: Pick<Domain, "host" | "includeSubdomains">): string[]`
  - `subdomainPattern(host: string): string` — `*://*.host/*`
  - `hostMatches(domain: Pick<Domain, "host" | "includeSubdomains">, host: string): boolean`

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/patterns.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { patternsFor, subdomainPattern, hostMatches } from "../src/lib/patterns";

describe("patternsFor", () => {
  it("returns exact host pattern only", () => {
    expect(patternsFor({ host: "github.com", includeSubdomains: false })).toEqual(["*://github.com/*"]);
  });
  it("adds subdomain pattern when enabled", () => {
    expect(patternsFor({ host: "github.com", includeSubdomains: true })).toEqual([
      "*://github.com/*",
      "*://*.github.com/*",
    ]);
  });
});

describe("subdomainPattern", () => {
  it("builds wildcard pattern", () => {
    expect(subdomainPattern("github.com")).toBe("*://*.github.com/*");
  });
});

describe("hostMatches", () => {
  const exact = { host: "github.com", includeSubdomains: false };
  const wide = { host: "github.com", includeSubdomains: true };
  it("matches exact host", () => {
    expect(hostMatches(exact, "github.com")).toBe(true);
    expect(hostMatches(wide, "github.com")).toBe(true);
  });
  it("matches subdomain only when enabled", () => {
    expect(hostMatches(exact, "gist.github.com")).toBe(false);
    expect(hostMatches(wide, "gist.github.com")).toBe(true);
    expect(hostMatches(wide, "a.b.github.com")).toBe(true);
  });
  it("does not match suffix lookalikes", () => {
    expect(hostMatches(wide, "notgithub.com")).toBe(false);
    expect(hostMatches(wide, "github.com.evil.com")).toBe(false);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/patterns.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: patterns.ts 구현**

```ts
import type { Domain } from "./types";

type HostRule = Pick<Domain, "host" | "includeSubdomains">;

export function subdomainPattern(host: string): string {
  return `*://*.${host}/*`;
}

export function patternsFor(domain: HostRule): string[] {
  const base = [`*://${domain.host}/*`];
  return domain.includeSubdomains ? [...base, subdomainPattern(domain.host)] : base;
}

export function hostMatches(domain: HostRule, host: string): boolean {
  if (host === domain.host) return true;
  return domain.includeSubdomains && host.endsWith(`.${domain.host}`);
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run tests/patterns.test.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add userscript-vault/src/lib/patterns.ts userscript-vault/tests/patterns.test.ts
git commit -m "feat: 도메인 match pattern 생성과 호스트 매칭"
```

---

### Task 4: storage 계층

`chrome.storage.local`을 호출하는 유일한 모듈. 테스트는 인메모리 가짜 `chrome` 객체로.

**Files:**
- Create: `src/lib/storage.ts`, `tests/fake-chrome.ts`
- Test: `tests/storage.test.ts`

**Interfaces:**
- Consumes: `Domain`, `ScriptMeta`, `StorageSnapshot`, `RunAt`, `World` (Task 2)
- Produces (전부 `src/lib/storage.ts` export):
  - `scriptsKey(domainId: string): string`, `codeKey(scriptId: string): string`
  - `readDomains(): Promise<Record<string, Domain>>`
  - `readScripts(domainId: string): Promise<Record<string, ScriptMeta>>`
  - `readCode(scriptId: string): Promise<string>`
  - `readErrors(): Promise<Record<string, string>>`
  - `readAll(): Promise<StorageSnapshot>`
  - `class DuplicateHostError extends Error`
  - `addDomain(input: { host: string; includeSubdomains: boolean }, now?: number): Promise<Domain>`
  - `updateDomain(id: string, patch: Partial<Pick<Domain, "enabled" | "includeSubdomains">>): Promise<Domain>`
  - `deleteDomain(id: string): Promise<void>`
  - `addScript(domainId: string, name: string, now?: number): Promise<ScriptMeta>`
  - `updateScriptMeta(domainId: string, scriptId: string, patch: Partial<Pick<ScriptMeta, "name" | "enabled" | "runAt" | "world">>, now?: number): Promise<ScriptMeta>`
  - `saveCode(domainId: string, scriptId: string, code: string, now?: number): Promise<void>`
  - `deleteScript(domainId: string, scriptId: string): Promise<void>`
  - `setErrors(errors: Record<string, string>): Promise<void>`
  - `applyBatch(set: Record<string, unknown>): Promise<void>`
- `tests/fake-chrome.ts`: `installFakeChrome(initial?: Record<string, unknown>): { dump(): Record<string, unknown> }`

- [ ] **Step 1: 가짜 chrome 작성**

`tests/fake-chrome.ts`:
```ts
type Store = Record<string, unknown>;

export function installFakeChrome(initial: Store = {}): { dump(): Store } {
  let store: Store = structuredClone(initial);

  const get = async (keys: null | string | string[]): Promise<Store> => {
    if (keys === null) return structuredClone(store);
    const list = typeof keys === "string" ? [keys] : keys;
    return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, structuredClone(store[k])]));
  };
  const set = async (items: Store): Promise<void> => {
    store = { ...store, ...structuredClone(items) };
  };
  const remove = async (keys: string | string[]): Promise<void> => {
    const list = typeof keys === "string" ? [keys] : keys;
    store = Object.fromEntries(Object.entries(store).filter(([k]) => !list.includes(k)));
  };

  (globalThis as unknown as { chrome: unknown }).chrome = { storage: { local: { get, set, remove } } };
  return { dump: () => structuredClone(store) };
}
```

- [ ] **Step 2: 실패하는 테스트 작성**

`tests/storage.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { installFakeChrome } from "./fake-chrome";
import {
  addDomain, updateDomain, deleteDomain, addScript, updateScriptMeta, saveCode, deleteScript,
  readAll, readDomains, readScripts, readCode, setErrors, applyBatch, DuplicateHostError,
  scriptsKey, codeKey,
} from "../src/lib/storage";

describe("storage", () => {
  let fake: ReturnType<typeof installFakeChrome>;
  beforeEach(() => {
    fake = installFakeChrome();
  });

  it("addDomain creates domain with empty scripts bucket", async () => {
    const d = await addDomain({ host: "github.com", includeSubdomains: false }, 1000);
    expect(d).toMatchObject({ host: "github.com", includeSubdomains: false, enabled: true, createdAt: 1000 });
    expect(d.id).toMatch(/[0-9a-f-]{36}/);
    const dump = fake.dump();
    expect(dump.domains).toEqual({ [d.id]: d });
    expect(dump[scriptsKey(d.id)]).toEqual({});
  });

  it("addDomain rejects duplicate host", async () => {
    await addDomain({ host: "github.com", includeSubdomains: false });
    await expect(addDomain({ host: "github.com", includeSubdomains: true })).rejects.toBeInstanceOf(DuplicateHostError);
  });

  it("updateDomain patches and returns new object", async () => {
    const d = await addDomain({ host: "a.com", includeSubdomains: false });
    const next = await updateDomain(d.id, { enabled: false, includeSubdomains: true });
    expect(next).toEqual({ ...d, enabled: false, includeSubdomains: true });
    expect((await readDomains())[d.id]).toEqual(next);
  });

  it("addScript creates meta with defaults and empty code", async () => {
    const d = await addDomain({ host: "a.com", includeSubdomains: false });
    const s = await addScript(d.id, "dark", 5);
    expect(s).toMatchObject({ domainId: d.id, name: "dark", enabled: true, runAt: "document_idle", world: "USER_SCRIPT", updatedAt: 5 });
    expect(await readScripts(d.id)).toEqual({ [s.id]: s });
    expect(await readCode(s.id)).toBe("");
  });

  it("saveCode stores code and bumps updatedAt", async () => {
    const d = await addDomain({ host: "a.com", includeSubdomains: false });
    const s = await addScript(d.id, "dark", 5);
    await saveCode(d.id, s.id, "console.log(1)", 9);
    expect(await readCode(s.id)).toBe("console.log(1)");
    expect((await readScripts(d.id))[s.id]?.updatedAt).toBe(9);
  });

  it("updateScriptMeta patches fields", async () => {
    const d = await addDomain({ host: "a.com", includeSubdomains: false });
    const s = await addScript(d.id, "dark");
    const next = await updateScriptMeta(d.id, s.id, { name: "light", world: "MAIN", enabled: false }, 7);
    expect(next).toEqual({ ...s, name: "light", world: "MAIN", enabled: false, updatedAt: 7 });
  });

  it("deleteScript removes meta and code", async () => {
    const d = await addDomain({ host: "a.com", includeSubdomains: false });
    const s = await addScript(d.id, "dark");
    await saveCode(d.id, s.id, "x", 1);
    await deleteScript(d.id, s.id);
    expect(await readScripts(d.id)).toEqual({});
    expect(codeKey(s.id) in fake.dump()).toBe(false);
  });

  it("deleteDomain cascades to scripts and code keys", async () => {
    const d = await addDomain({ host: "a.com", includeSubdomains: false });
    const keep = await addDomain({ host: "b.com", includeSubdomains: false });
    const s1 = await addScript(d.id, "one");
    const s2 = await addScript(d.id, "two");
    await deleteDomain(d.id);
    const dump = fake.dump();
    expect(Object.keys(dump).sort()).toEqual(["domains", scriptsKey(keep.id)].sort());
    expect(dump.domains).toEqual({ [keep.id]: keep });
    expect(codeKey(s1.id) in dump).toBe(false);
    expect(codeKey(s2.id) in dump).toBe(false);
  });

  it("readAll assembles snapshot", async () => {
    const d = await addDomain({ host: "a.com", includeSubdomains: false });
    const s = await addScript(d.id, "one");
    await saveCode(d.id, s.id, "code", 1);
    await setErrors({ [d.id]: "boom" });
    const snap = await readAll();
    expect(snap.domains[d.id]?.host).toBe("a.com");
    expect(snap.scripts[d.id]?.[s.id]?.name).toBe("one");
    expect(snap.code[s.id]).toBe("code");
    expect(snap.errors).toEqual({ [d.id]: "boom" });
  });

  it("applyBatch writes all keys at once", async () => {
    await applyBatch({ domains: { x: 1 }, "code:y": "z" });
    expect(fake.dump()).toEqual({ domains: { x: 1 }, "code:y": "z" });
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `npx vitest run tests/storage.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 4: storage.ts 구현**

```ts
import type { Domain, ScriptMeta, StorageSnapshot } from "./types";

export const scriptsKey = (domainId: string): string => `scripts:${domainId}`;
export const codeKey = (scriptId: string): string => `code:${scriptId}`;

const SCRIPTS_PREFIX = "scripts:";
const CODE_PREFIX = "code:";

const local = () => chrome.storage.local;

export class DuplicateHostError extends Error {
  constructor(host: string) {
    super(`이미 등록된 호스트: ${host}`);
    this.name = "DuplicateHostError";
  }
}

export async function readDomains(): Promise<Record<string, Domain>> {
  const r = await local().get("domains");
  return (r.domains as Record<string, Domain> | undefined) ?? {};
}

export async function readScripts(domainId: string): Promise<Record<string, ScriptMeta>> {
  const key = scriptsKey(domainId);
  const r = await local().get(key);
  return (r[key] as Record<string, ScriptMeta> | undefined) ?? {};
}

export async function readCode(scriptId: string): Promise<string> {
  const key = codeKey(scriptId);
  const r = await local().get(key);
  return (r[key] as string | undefined) ?? "";
}

export async function readErrors(): Promise<Record<string, string>> {
  const r = await local().get("errors");
  return (r.errors as Record<string, string> | undefined) ?? {};
}

export async function readAll(): Promise<StorageSnapshot> {
  const all = await local().get(null);
  const domains: Record<string, Domain> = {};
  const scripts: Record<string, Record<string, ScriptMeta>> = {};
  const code: Record<string, string> = {};
  const errors: Record<string, string> = {};
  for (const [key, value] of Object.entries(all)) {
    if (key === "domains") Object.assign(domains, value as Record<string, Domain>);
    else if (key === "errors") Object.assign(errors, value as Record<string, string>);
    else if (key.startsWith(SCRIPTS_PREFIX)) scripts[key.slice(SCRIPTS_PREFIX.length)] = value as Record<string, ScriptMeta>;
    else if (key.startsWith(CODE_PREFIX)) code[key.slice(CODE_PREFIX.length)] = value as string;
  }
  return { domains, scripts, code, errors };
}

export async function addDomain(
  input: { host: string; includeSubdomains: boolean },
  now: number = Date.now(),
): Promise<Domain> {
  const domains = await readDomains();
  if (Object.values(domains).some((d) => d.host === input.host)) throw new DuplicateHostError(input.host);
  const domain: Domain = {
    id: crypto.randomUUID(),
    host: input.host,
    includeSubdomains: input.includeSubdomains,
    enabled: true,
    createdAt: now,
  };
  await local().set({ domains: { ...domains, [domain.id]: domain }, [scriptsKey(domain.id)]: {} });
  return domain;
}

export async function updateDomain(
  id: string,
  patch: Partial<Pick<Domain, "enabled" | "includeSubdomains">>,
): Promise<Domain> {
  const domains = await readDomains();
  const current = domains[id];
  if (!current) throw new Error(`도메인을 찾을 수 없음: ${id}`);
  const next: Domain = { ...current, ...patch };
  await local().set({ domains: { ...domains, [id]: next } });
  return next;
}

export async function deleteDomain(id: string): Promise<void> {
  const domains = await readDomains();
  if (!domains[id]) return;
  const scripts = await readScripts(id);
  const { [id]: _removed, ...rest } = domains;
  // 자식 먼저 지운다. 중간에 끊겨도 고아 code 키가 아니라 빈 도메인이 남는 쪽이 복구하기 쉽다.
  await local().remove([scriptsKey(id), ...Object.keys(scripts).map(codeKey)]);
  await local().set({ domains: rest });
}

export async function addScript(domainId: string, name: string, now: number = Date.now()): Promise<ScriptMeta> {
  const scripts = await readScripts(domainId);
  const meta: ScriptMeta = {
    id: crypto.randomUUID(),
    domainId,
    name,
    enabled: true,
    runAt: "document_idle",
    world: "USER_SCRIPT",
    updatedAt: now,
  };
  await local().set({ [scriptsKey(domainId)]: { ...scripts, [meta.id]: meta }, [codeKey(meta.id)]: "" });
  return meta;
}

export async function updateScriptMeta(
  domainId: string,
  scriptId: string,
  patch: Partial<Pick<ScriptMeta, "name" | "enabled" | "runAt" | "world">>,
  now: number = Date.now(),
): Promise<ScriptMeta> {
  const scripts = await readScripts(domainId);
  const current = scripts[scriptId];
  if (!current) throw new Error(`스크립트를 찾을 수 없음: ${scriptId}`);
  const next: ScriptMeta = { ...current, ...patch, updatedAt: now };
  await local().set({ [scriptsKey(domainId)]: { ...scripts, [scriptId]: next } });
  return next;
}

export async function saveCode(domainId: string, scriptId: string, code: string, now: number = Date.now()): Promise<void> {
  const scripts = await readScripts(domainId);
  const current = scripts[scriptId];
  if (!current) throw new Error(`스크립트를 찾을 수 없음: ${scriptId}`);
  await local().set({
    [codeKey(scriptId)]: code,
    [scriptsKey(domainId)]: { ...scripts, [scriptId]: { ...current, updatedAt: now } },
  });
}

export async function deleteScript(domainId: string, scriptId: string): Promise<void> {
  const scripts = await readScripts(domainId);
  const { [scriptId]: _removed, ...rest } = scripts;
  await local().remove(codeKey(scriptId));
  await local().set({ [scriptsKey(domainId)]: rest });
}

export async function setErrors(errors: Record<string, string>): Promise<void> {
  await local().set({ errors });
}

export async function applyBatch(set: Record<string, unknown>): Promise<void> {
  await local().set(set);
}
```

- [ ] **Step 5: 통과 확인**

Run: `npx vitest run tests/storage.test.ts`
Expected: PASS (10개)

- [ ] **Step 6: 커밋**

```bash
git add userscript-vault/src/lib/storage.ts userscript-vault/tests/fake-chrome.ts userscript-vault/tests/storage.test.ts
git commit -m "feat: storage.local 접근 계층"
```

---

### Task 5: 등록 목록 계산 (registry)

storage 스냅샷 → `userScripts.register` 입력. 순수 함수. background의 재동기화 판단 함수도 여기.

**Files:**
- Create: `src/lib/registry.ts`
- Test: `tests/registry.test.ts`

**Interfaces:**
- Consumes: `StorageSnapshot`, `RunAt`, `World` (Task 2), `patternsFor` (Task 3)
- Produces:
  - `interface Registration { id: string; matches: string[]; js: [{ code: string }]; runAt: RunAt; world: World }`
  - `interface RegistrationGroup { domainId: string; registrations: Registration[] }`
  - `buildRegistrations(snapshot: StorageSnapshot, grantedOrigins: string[]): { groups: RegistrationGroup[]; missingPermission: string[] }`
  - `shouldResync(changedKeys: string[]): boolean` — `errors` 키만 바뀐 변경은 false

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/registry.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { buildRegistrations, shouldResync } from "../src/lib/registry";
import type { StorageSnapshot, Domain, ScriptMeta } from "../src/lib/types";

const domain = (id: string, host: string, extra: Partial<Domain> = {}): Domain => ({
  id, host, includeSubdomains: false, enabled: true, createdAt: 0, ...extra,
});
const script = (id: string, domainId: string, extra: Partial<ScriptMeta> = {}): ScriptMeta => ({
  id, domainId, name: id, enabled: true, runAt: "document_idle", world: "USER_SCRIPT", updatedAt: 0, ...extra,
});

function snapshot(parts: Partial<StorageSnapshot>): StorageSnapshot {
  return { domains: {}, scripts: {}, code: {}, errors: {}, ...parts };
}

describe("buildRegistrations", () => {
  it("registers enabled scripts of enabled domains with granted permission", () => {
    const snap = snapshot({
      domains: { d1: domain("d1", "a.com") },
      scripts: { d1: { s1: script("s1", "d1", { runAt: "document_start", world: "MAIN" }) } },
      code: { s1: "alert(1)" },
    });
    const { groups, missingPermission } = buildRegistrations(snap, ["*://a.com/*"]);
    expect(missingPermission).toEqual([]);
    expect(groups).toEqual([
      { domainId: "d1", registrations: [{ id: "s1", matches: ["*://a.com/*"], js: [{ code: "alert(1)" }], runAt: "document_start", world: "MAIN" }] },
    ]);
  });

  it("skips when domain disabled even if script enabled, and vice versa", () => {
    const snap = snapshot({
      domains: { d1: domain("d1", "a.com", { enabled: false }), d2: domain("d2", "b.com") },
      scripts: { d1: { s1: script("s1", "d1") }, d2: { s2: script("s2", "d2", { enabled: false }) } },
      code: { s1: "x", s2: "y" },
    });
    const { groups } = buildRegistrations(snap, ["*://a.com/*", "*://b.com/*"]);
    expect(groups.flatMap((g) => g.registrations)).toEqual([]);
  });

  it("skips empty code", () => {
    const snap = snapshot({
      domains: { d1: domain("d1", "a.com") },
      scripts: { d1: { s1: script("s1", "d1"), s2: script("s2", "d1") } },
      code: { s1: "", s2: "   " },
    });
    const { groups } = buildRegistrations(snap, ["*://a.com/*"]);
    expect(groups.flatMap((g) => g.registrations)).toEqual([]);
  });

  it("reports domains without granted origins and excludes them", () => {
    const snap = snapshot({
      domains: { d1: domain("d1", "a.com", { includeSubdomains: true }) },
      scripts: { d1: { s1: script("s1", "d1") } },
      code: { s1: "x" },
    });
    const partial = buildRegistrations(snap, ["*://a.com/*"]); // 서브도메인 패턴 누락
    expect(partial.missingPermission).toEqual(["d1"]);
    expect(partial.groups).toEqual([]);

    const full = buildRegistrations(snap, ["*://a.com/*", "*://*.a.com/*"]);
    expect(full.missingPermission).toEqual([]);
    expect(full.groups[0]?.registrations[0]?.matches).toEqual(["*://a.com/*", "*://*.a.com/*"]);
  });

  it("treats <all_urls> as covering everything", () => {
    const snap = snapshot({
      domains: { d1: domain("d1", "a.com", { includeSubdomains: true }) },
      scripts: { d1: { s1: script("s1", "d1") } },
      code: { s1: "x" },
    });
    expect(buildRegistrations(snap, ["<all_urls>"]).missingPermission).toEqual([]);
  });

  it("does not report missing permission for domains with no runnable scripts", () => {
    const snap = snapshot({ domains: { d1: domain("d1", "a.com") }, scripts: { d1: {} } });
    expect(buildRegistrations(snap, []).missingPermission).toEqual([]);
  });
});

describe("shouldResync", () => {
  it("ignores changes that only touch errors", () => {
    expect(shouldResync(["errors"])).toBe(false);
  });
  it("resyncs on any other key", () => {
    expect(shouldResync(["domains"])).toBe(true);
    expect(shouldResync(["errors", "code:abc"])).toBe(true);
    expect(shouldResync(["scripts:d1"])).toBe(true);
  });
  it("ignores empty change sets", () => {
    expect(shouldResync([])).toBe(false);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/registry.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: registry.ts 구현**

```ts
import type { RunAt, StorageSnapshot, World } from "./types";
import { patternsFor } from "./patterns";

export interface Registration {
  id: string;
  matches: string[];
  js: [{ code: string }];
  runAt: RunAt;
  world: World;
}

export interface RegistrationGroup {
  domainId: string;
  registrations: Registration[];
}

const ALL_URLS = "<all_urls>";

function covers(granted: string[], patterns: string[]): boolean {
  // ponytail: 문자열 일치 비교. 사용자가 chrome://extensions에서 수동으로 넓은 권한을 준 경우는 <all_urls>만 인식.
  if (granted.includes(ALL_URLS)) return true;
  return patterns.every((p) => granted.includes(p));
}

export function buildRegistrations(
  snapshot: StorageSnapshot,
  grantedOrigins: string[],
): { groups: RegistrationGroup[]; missingPermission: string[] } {
  const groups: RegistrationGroup[] = [];
  const missingPermission: string[] = [];

  for (const domain of Object.values(snapshot.domains)) {
    if (!domain.enabled) continue;
    const matches = patternsFor(domain);
    const registrations: Registration[] = Object.values(snapshot.scripts[domain.id] ?? {})
      .filter((s) => s.enabled && (snapshot.code[s.id] ?? "").trim().length > 0)
      .map((s) => ({ id: s.id, matches, js: [{ code: snapshot.code[s.id] ?? "" }], runAt: s.runAt, world: s.world }));
    if (registrations.length === 0) continue;
    if (!covers(grantedOrigins, matches)) {
      missingPermission.push(domain.id);
      continue;
    }
    groups.push({ domainId: domain.id, registrations });
  }
  return { groups, missingPermission };
}

export function shouldResync(changedKeys: string[]): boolean {
  return changedKeys.some((k) => k !== "errors");
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run tests/registry.test.ts`
Expected: PASS (9개)

- [ ] **Step 5: 커밋**

```bash
git add userscript-vault/src/lib/registry.ts userscript-vault/tests/registry.test.ts
git commit -m "feat: userScripts 등록 목록 계산"
```

---

### Task 6: background 서비스 워커

`chrome.userScripts`를 호출하는 유일한 모듈. 자동 테스트 없음 (크롬 API). 수동 확인 포함.

**Files:**
- Modify: `src/background.ts` (Task 1의 내용 전체 교체)

**Interfaces:**
- Consumes: `readAll`, `setErrors` (Task 4), `buildRegistrations`, `shouldResync`, `Registration`, `RegistrationGroup` (Task 5)

- [ ] **Step 1: background.ts 작성**

```ts
import { readAll, setErrors } from "./lib/storage";
import { buildRegistrations, shouldResync, type RegistrationGroup } from "./lib/registry";

const DEBOUNCE_MS = 100;
const MISSING_PERMISSION_MESSAGE = "호스트 권한이 없습니다. 도메인을 삭제하고 다시 추가하세요.";

let timer: ReturnType<typeof setTimeout> | undefined;

function userScriptsAvailable(): boolean {
  return typeof chrome.userScripts !== "undefined";
}

function schedule(): void {
  clearTimeout(timer);
  timer = setTimeout(() => void resync(), DEBOUNCE_MS);
}

async function registerGroups(groups: RegistrationGroup[]): Promise<Record<string, string>> {
  const all = groups.flatMap((g) => g.registrations);
  if (all.length === 0) return {};
  try {
    await chrome.userScripts.register(all);
    return {};
  } catch {
    // 일괄 등록 실패. 도메인 단위로 나눠 실패한 도메인만 제외한다.
    const errors: Record<string, string> = {};
    for (const group of groups) {
      try {
        await chrome.userScripts.register(group.registrations);
      } catch (e) {
        errors[group.domainId] = e instanceof Error ? e.message : String(e);
      }
    }
    return errors;
  }
}

async function resync(): Promise<void> {
  if (!userScriptsAvailable()) return;
  const snapshot = await readAll();
  const { origins = [] } = await chrome.permissions.getAll();
  const { groups, missingPermission } = buildRegistrations(snapshot, origins);

  await chrome.userScripts.unregister();
  const registerErrors = await registerGroups(groups);

  const errors: Record<string, string> = { ...registerErrors };
  for (const domainId of missingPermission) errors[domainId] = MISSING_PERMISSION_MESSAGE;
  await setErrors(errors);
}

chrome.runtime.onInstalled.addListener(() => void resync());
chrome.runtime.onStartup.addListener(() => void resync());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && shouldResync(Object.keys(changes))) schedule();
});
chrome.permissions.onAdded.addListener(schedule);
chrome.permissions.onRemoved.addListener(schedule);
```

`@types/chrome`에 `chrome.userScripts`가 없어 타입 오류가 나면 `src/chrome-userscripts.d.ts`를 만들어 아래를 넣는다:

```ts
declare namespace chrome.userScripts {
  interface ScriptSource { code?: string; file?: string }
  interface RegisteredUserScript {
    id: string;
    matches?: string[];
    excludeMatches?: string[];
    js?: ScriptSource[];
    runAt?: "document_start" | "document_end" | "document_idle";
    world?: "USER_SCRIPT" | "MAIN";
    allFrames?: boolean;
  }
  interface UserScriptFilter { ids?: string[] }
  function register(scripts: RegisteredUserScript[]): Promise<void>;
  function update(scripts: RegisteredUserScript[]): Promise<void>;
  function unregister(filter?: UserScriptFilter): Promise<void>;
  function getScripts(filter?: UserScriptFilter): Promise<RegisteredUserScript[]>;
}
```

- [ ] **Step 2: 타입 검사와 빌드**

Run: `npm run build`
Expected: 오류 없음

- [ ] **Step 3: 수동 확인**

1. `chrome://extensions`에서 확장 새로고침. 세부정보 → "사용자 스크립트 허용" 켜기 (Chrome 138 미만이면 개발자 모드).
2. 서비스 워커 콘솔 열기 (카드의 "서비스 워커" 링크). 아래를 콘솔에 붙여 넣어 임시 데이터 주입:
   ```js
   // 콘솔에서는 permissions.request를 못 부른다. 먼저 chrome://extensions → 세부정보 → 사이트 액세스에서 example.com 을 허용해 둔다.
   const d = crypto.randomUUID(), s = crypto.randomUUID();
   await chrome.storage.local.set({
     domains: { [d]: { id: d, host: "example.com", includeSubdomains: false, enabled: true, createdAt: 0 } },
     [`scripts:${d}`]: { [s]: { id: s, domainId: d, name: "t", enabled: true, runAt: "document_idle", world: "USER_SCRIPT", updatedAt: 0 } },
     [`code:${s}`]: "document.title = 'VAULT OK'",
   });
   ```
3. `await chrome.userScripts.getScripts()` → 길이 1, `matches: ["*://example.com/*"]`.
4. `https://example.com` 새 탭 → 탭 제목이 `VAULT OK`.
5. `await chrome.storage.local.set({ domains: {} })` 후 100ms 뒤 `getScripts()` → 빈 배열. example.com 새로고침 → 제목 원복.
6. 사이트 액세스 권한을 제거하고 도메인을 다시 넣으면 `(await chrome.storage.local.get("errors")).errors`에 해당 도메인 id와 권한 메시지.
7. 끝나면 `await chrome.storage.local.clear()`.

- [ ] **Step 4: 커밋**

```bash
git add userscript-vault/src/background.ts userscript-vault/src/chrome-userscripts.d.ts
git commit -m "feat: background 재동기화 (storage → userScripts)"
```

(`chrome-userscripts.d.ts`는 만들었을 때만.)

---

### Task 7: 문법 검사 (lezer)

**Files:**
- Create: `src/lib/validate.ts`
- Test: `tests/validate.test.ts`

**Interfaces:**
- Produces: `findSyntaxError(code: string): { line: number } | null`

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/validate.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { findSyntaxError } from "../src/lib/validate";

describe("findSyntaxError", () => {
  it("returns null for valid code", () => {
    expect(findSyntaxError("const x = 1;\nconsole.log(x);")).toBeNull();
    expect(findSyntaxError("")).toBeNull();
    expect(findSyntaxError("async function f() { await g?.(); }\nclass A { #p = 1 }")).toBeNull();
  });

  it("reports the line of the first error", () => {
    expect(findSyntaxError("const ok = 1;\nconst x = ;")).toEqual({ line: 2 });
    expect(findSyntaxError("function f( {")).toEqual({ line: 1 });
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/validate.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: validate.ts 구현**

```ts
import { javascriptLanguage } from "@codemirror/lang-javascript";

// MV3 확장 페이지 CSP가 eval/new Function을 막으므로 에디터가 이미 쓰는 lezer 파서로 검사한다.
export function findSyntaxError(code: string): { line: number } | null {
  const tree = javascriptLanguage.parser.parse(code);
  let errorPos = -1;
  tree.iterate({
    enter(node) {
      if (errorPos >= 0) return false;
      if (node.type.isError) {
        errorPos = node.from;
        return false;
      }
      return undefined;
    },
  });
  if (errorPos < 0) return null;
  const line = code.slice(0, errorPos).split("\n").length;
  return { line };
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run tests/validate.test.ts`
Expected: PASS

lezer가 유효한 코드에 오류 노드를 내면(최신 문법 등) 그 케이스를 테스트에서 빼지 말고, 해당 문법이 실제로 `@lezer/javascript` 미지원인지 확인한 뒤 테스트 입력을 바꾼다.

- [ ] **Step 5: 커밋**

```bash
git add userscript-vault/src/lib/validate.ts userscript-vault/tests/validate.test.ts
git commit -m "feat: lezer 기반 JS 문법 검사"
```

---

### Task 8: zip 내보내기 / 가져오기 (archive)

**Files:**
- Create: `src/lib/archive.ts`
- Test: `tests/archive.test.ts`

**Interfaces:**
- Consumes: `StorageSnapshot`, `ExportManifest`, `SCHEMA_VERSION`, `RUN_AT_VALUES`, `WORLD_VALUES`, `Domain`, `ScriptMeta` (Task 2), `normalizeHost` (Task 2), `patternsFor` (Task 3), `scriptsKey`, `codeKey` (Task 4)
- Produces:
  - `safeFileName(name: string): string`
  - `buildExport(snapshot: StorageSnapshot, now: Date): Uint8Array`
  - `interface ParsedScript { name: string; enabled: boolean; runAt: RunAt; world: World; code: string }`
  - `interface ParsedDomain { host: string; includeSubdomains: boolean; enabled: boolean; scripts: ParsedScript[] }`
  - `interface ParsedImport { domains: ParsedDomain[]; skipped: string[] }`
  - `parseImport(bytes: Uint8Array): { ok: true; value: ParsedImport } | { ok: false; error: string }`
  - `type ConflictPolicy = "overwrite" | "skip"`
  - `interface ImportPlan { set: Record<string, unknown>; newOrigins: string[]; summary: { added: number; overwritten: number; skipped: number } }`
  - `planImport(parsed: ParsedImport, snapshot: StorageSnapshot, policy: ConflictPolicy, now: number, newId?: () => string): ImportPlan`

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/archive.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { unzipSync, strFromU8, zipSync, strToU8 } from "fflate";
import { safeFileName, buildExport, parseImport, planImport } from "../src/lib/archive";
import type { StorageSnapshot, Domain, ScriptMeta, ExportManifest } from "../src/lib/types";
import { scriptsKey, codeKey } from "../src/lib/storage";

const domain = (id: string, host: string, extra: Partial<Domain> = {}): Domain => ({
  id, host, includeSubdomains: false, enabled: true, createdAt: 0, ...extra,
});
const script = (id: string, domainId: string, name: string, extra: Partial<ScriptMeta> = {}): ScriptMeta => ({
  id, domainId, name, enabled: true, runAt: "document_idle", world: "USER_SCRIPT", updatedAt: 0, ...extra,
});
const snap = (parts: Partial<StorageSnapshot>): StorageSnapshot => ({ domains: {}, scripts: {}, code: {}, errors: {}, ...parts });

describe("safeFileName", () => {
  it("replaces forbidden characters and trims", () => {
    expect(safeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe("a_b_c_d_e_f_g_h_i_j");
    expect(safeFileName("  .hidden. ")).toBe("hidden");
    expect(safeFileName("tab\there")).toBe("tab_here");
  });
  it("falls back to 'script' when nothing is left", () => {
    expect(safeFileName("???")).toBe("___");
    expect(safeFileName("...")).toBe("script");
    expect(safeFileName("")).toBe("script");
  });
});

describe("buildExport", () => {
  it("writes export.json and one file per script, deduplicating names", () => {
    const s = snap({
      domains: { d1: domain("d1", "a.com", { includeSubdomains: true, enabled: false }) },
      scripts: { d1: { s1: script("s1", "d1", "x/y", { world: "MAIN" }), s2: script("s2", "d1", "x_y", { enabled: false }), s3: script("s3", "d1", "...") } },
      code: { s1: "one", s2: "two", s3: "three" },
    });
    const files = unzipSync(buildExport(s, new Date("2026-10-07T00:00:00Z")));
    const manifest = JSON.parse(strFromU8(files["export.json"]!)) as ExportManifest;
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.exportedAt).toBe("2026-10-07T00:00:00.000Z");
    expect(manifest.domains).toEqual([
      {
        host: "a.com", includeSubdomains: true, enabled: false,
        scripts: [
          { name: "x/y", file: "a.com/x_y.js", enabled: true, runAt: "document_idle", world: "MAIN" },
          { name: "x_y", file: "a.com/x_y-2.js", enabled: false, runAt: "document_idle", world: "USER_SCRIPT" },
          { name: "...", file: "a.com/script.js", enabled: true, runAt: "document_idle", world: "USER_SCRIPT" },
        ],
      },
    ]);
    expect(strFromU8(files["a.com/x_y.js"]!)).toBe("one");
    expect(strFromU8(files["a.com/x_y-2.js"]!)).toBe("two");
    expect(strFromU8(files["a.com/script.js"]!)).toBe("three");
  });
});

describe("parseImport", () => {
  const zipOf = (files: Record<string, string>) =>
    zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));

  it("rejects garbage, missing export.json, bad json, wrong schema", () => {
    expect(parseImport(new Uint8Array([1, 2, 3]))).toMatchObject({ ok: false });
    expect(parseImport(zipOf({ "a.com/x.js": "" }))).toEqual({ ok: false, error: "export.json이 없습니다" });
    expect(parseImport(zipOf({ "export.json": "{" }))).toMatchObject({ ok: false });
    expect(parseImport(zipOf({ "export.json": JSON.stringify({ schemaVersion: 99, domains: [] }) }))).toMatchObject({ ok: false });
  });

  it("parses domains and scripts, skipping missing files and fixing bad enums", () => {
    const manifest = {
      schemaVersion: 1, exportedAt: "x",
      domains: [
        {
          host: "A.com", includeSubdomains: true, enabled: true,
          scripts: [
            { name: "ok", file: "A.com/ok.js", enabled: false, runAt: "document_start", world: "MAIN" },
            { name: "gone", file: "A.com/gone.js", enabled: true, runAt: "document_idle", world: "USER_SCRIPT" },
            { name: "weird", file: "A.com/weird.js", runAt: "whenever", world: "MARS" },
          ],
        },
        { host: "not a host", scripts: [] },
        { nohost: true },
      ],
    };
    const result = parseImport(zipOf({ "export.json": JSON.stringify(manifest), "A.com/ok.js": "1", "A.com/weird.js": "2" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.domains).toEqual([
      {
        host: "a.com", includeSubdomains: true, enabled: true,
        scripts: [
          { name: "ok", enabled: false, runAt: "document_start", world: "MAIN", code: "1" },
          { name: "weird", enabled: true, runAt: "document_idle", world: "USER_SCRIPT", code: "2" },
        ],
      },
    ]);
    expect(result.value.skipped).toHaveLength(3);
  });
});

describe("planImport", () => {
  let n = 0;
  const newId = () => `id${++n}`;

  it("creates new domain, requests origins, adds scripts", () => {
    n = 0;
    const plan = planImport(
      { domains: [{ host: "a.com", includeSubdomains: true, enabled: false, scripts: [{ name: "s", enabled: true, runAt: "document_idle", world: "USER_SCRIPT", code: "c" }] }], skipped: ["x"] },
      snap({}), "skip", 42, newId,
    );
    expect(plan.newOrigins).toEqual(["*://a.com/*", "*://*.a.com/*"]);
    expect(plan.summary).toEqual({ added: 1, overwritten: 0, skipped: 1 });
    expect(plan.set.domains).toEqual({ id1: { id: "id1", host: "a.com", includeSubdomains: true, enabled: false, createdAt: 42 } });
    expect(plan.set[scriptsKey("id1")]).toEqual({ id2: { id: "id2", domainId: "id1", name: "s", enabled: true, runAt: "document_idle", world: "USER_SCRIPT", updatedAt: 42 } });
    expect(plan.set[codeKey("id2")]).toBe("c");
  });

  it("merges into existing domain keeping its flags, honoring skip policy", () => {
    n = 0;
    const existing = snap({
      domains: { d1: domain("d1", "a.com", { includeSubdomains: false, enabled: true }) },
      scripts: { d1: { s1: script("s1", "d1", "dup") } },
      code: { s1: "old" },
    });
    const parsed = { domains: [{ host: "a.com", includeSubdomains: true, enabled: false, scripts: [
      { name: "dup", enabled: false, runAt: "document_start", world: "MAIN", code: "new" },
      { name: "fresh", enabled: true, runAt: "document_idle", world: "USER_SCRIPT", code: "f" },
    ] }], skipped: [] };
    const plan = planImport(parsed, existing, "skip", 7, newId);
    expect(plan.newOrigins).toEqual([]);
    expect(plan.summary).toEqual({ added: 1, overwritten: 0, skipped: 1 });
    expect((plan.set.domains as Record<string, Domain>).d1).toEqual(existing.domains.d1);
    const scripts = plan.set[scriptsKey("d1")] as Record<string, ScriptMeta>;
    expect(scripts.s1).toEqual(existing.scripts.d1!.s1);
    expect(Object.values(scripts).map((s) => s.name).sort()).toEqual(["dup", "fresh"]);
    expect(codeKey("s1") in plan.set).toBe(false);
  });

  it("overwrites existing script keeping its id", () => {
    n = 0;
    const existing = snap({
      domains: { d1: domain("d1", "a.com") },
      scripts: { d1: { s1: script("s1", "d1", "dup") } },
      code: { s1: "old" },
    });
    const parsed = { domains: [{ host: "a.com", includeSubdomains: false, enabled: true, scripts: [
      { name: "dup", enabled: false, runAt: "document_start", world: "MAIN", code: "new" },
    ] }], skipped: [] };
    const plan = planImport(parsed, existing, "overwrite", 7, newId);
    expect(plan.summary).toEqual({ added: 0, overwritten: 1, skipped: 0 });
    expect((plan.set[scriptsKey("d1")] as Record<string, ScriptMeta>).s1).toEqual({
      id: "s1", domainId: "d1", name: "dup", enabled: false, runAt: "document_start", world: "MAIN", updatedAt: 7,
    });
    expect(plan.set[codeKey("s1")]).toBe("new");
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run tests/archive.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: archive.ts 구현**

```ts
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import {
  SCHEMA_VERSION, RUN_AT_VALUES, WORLD_VALUES,
  type Domain, type ExportManifest, type RunAt, type ScriptMeta, type StorageSnapshot, type World,
} from "./types";
import { normalizeHost } from "./host";
import { patternsFor } from "./patterns";
import { scriptsKey, codeKey } from "./storage";

const FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f]/g;
const EDGE_TRIM = /^[\s.]+|[\s.]+$/g;
const FALLBACK_NAME = "script";
const MANIFEST_FILE = "export.json";

export function safeFileName(name: string): string {
  const cleaned = name.replace(FORBIDDEN, "_").replace(EDGE_TRIM, "");
  return cleaned.length > 0 ? cleaned : FALLBACK_NAME;
}

function uniqueFileNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    const base = safeFileName(name);
    let candidate = base;
    for (let n = 2; used.has(candidate); n++) candidate = `${base}-${n}`;
    used.add(candidate);
    return candidate;
  });
}

export function buildExport(snapshot: StorageSnapshot, now: Date): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const domains: ExportManifest["domains"] = Object.values(snapshot.domains).map((domain) => {
    const metas = Object.values(snapshot.scripts[domain.id] ?? {});
    const fileNames = uniqueFileNames(metas.map((m) => m.name));
    const scripts = metas.map((meta, i) => {
      const file = `${domain.host}/${fileNames[i]}.js`;
      files[file] = strToU8(snapshot.code[meta.id] ?? "");
      return { name: meta.name, file, enabled: meta.enabled, runAt: meta.runAt, world: meta.world };
    });
    return { host: domain.host, includeSubdomains: domain.includeSubdomains, enabled: domain.enabled, scripts };
  });
  const manifest: ExportManifest = { schemaVersion: SCHEMA_VERSION, exportedAt: now.toISOString(), domains };
  files[MANIFEST_FILE] = strToU8(JSON.stringify(manifest, null, 2));
  return zipSync(files);
}

export interface ParsedScript { name: string; enabled: boolean; runAt: RunAt; world: World; code: string }
export interface ParsedDomain { host: string; includeSubdomains: boolean; enabled: boolean; scripts: ParsedScript[] }
export interface ParsedImport { domains: ParsedDomain[]; skipped: string[] }
export type ParseResult = { ok: true; value: ParsedImport } | { ok: false; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function pickEnum<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export function parseImport(bytes: Uint8Array): ParseResult {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    return { ok: false, error: "zip 파일을 읽을 수 없습니다" };
  }
  const raw = files[MANIFEST_FILE];
  if (!raw) return { ok: false, error: "export.json이 없습니다" };

  let manifest: unknown;
  try {
    manifest = JSON.parse(strFromU8(raw));
  } catch {
    return { ok: false, error: "export.json이 올바른 JSON이 아닙니다" };
  }
  if (!isRecord(manifest) || manifest.schemaVersion !== SCHEMA_VERSION || !Array.isArray(manifest.domains)) {
    const version = isRecord(manifest) ? String(manifest.schemaVersion) : "?";
    return { ok: false, error: `지원하지 않는 형식입니다 (schemaVersion ${version})` };
  }

  const skipped: string[] = [];
  const domains: ParsedDomain[] = [];
  for (const d of manifest.domains) {
    if (!isRecord(d) || typeof d.host !== "string") {
      skipped.push("호스트가 없는 도메인 항목");
      continue;
    }
    const host = normalizeHost(d.host);
    if (!host.ok) {
      skipped.push(`잘못된 호스트: ${d.host}`);
      continue;
    }
    const scripts: ParsedScript[] = [];
    for (const s of Array.isArray(d.scripts) ? d.scripts : []) {
      if (!isRecord(s) || typeof s.name !== "string" || typeof s.file !== "string") {
        skipped.push(`${host.host}: 이름 또는 파일이 없는 스크립트`);
        continue;
      }
      const body = files[s.file];
      if (!body) {
        skipped.push(`${host.host}/${s.name}: 파일 없음 (${s.file})`);
        continue;
      }
      scripts.push({
        name: s.name,
        enabled: s.enabled !== false,
        runAt: pickEnum(RUN_AT_VALUES, s.runAt, "document_idle"),
        world: pickEnum(WORLD_VALUES, s.world, "USER_SCRIPT"),
        code: strFromU8(body),
      });
    }
    domains.push({ host: host.host, includeSubdomains: d.includeSubdomains === true, enabled: d.enabled !== false, scripts });
  }
  return { ok: true, value: { domains, skipped } };
}

export type ConflictPolicy = "overwrite" | "skip";

export interface ImportPlan {
  set: Record<string, unknown>;
  newOrigins: string[];
  summary: { added: number; overwritten: number; skipped: number };
}

export function planImport(
  parsed: ParsedImport,
  snapshot: StorageSnapshot,
  policy: ConflictPolicy,
  now: number,
  newId: () => string = () => crypto.randomUUID(),
): ImportPlan {
  const domains: Record<string, Domain> = { ...snapshot.domains };
  const set: Record<string, unknown> = {};
  const newOrigins: string[] = [];
  const summary = { added: 0, overwritten: 0, skipped: parsed.skipped.length };

  for (const pd of parsed.domains) {
    const found = Object.values(domains).find((d) => d.host === pd.host);
    const domain: Domain = found ?? {
      id: newId(), host: pd.host, includeSubdomains: pd.includeSubdomains, enabled: pd.enabled, createdAt: now,
    };
    if (!found) {
      domains[domain.id] = domain;
      newOrigins.push(...patternsFor(domain));
    }

    const scripts: Record<string, ScriptMeta> = { ...(snapshot.scripts[domain.id] ?? {}) };
    for (const ps of pd.scripts) {
      const existing = Object.values(scripts).find((s) => s.name === ps.name);
      if (existing && policy === "skip") {
        summary.skipped++;
        continue;
      }
      const id = existing?.id ?? newId();
      scripts[id] = { id, domainId: domain.id, name: ps.name, enabled: ps.enabled, runAt: ps.runAt, world: ps.world, updatedAt: now };
      set[codeKey(id)] = ps.code;
      if (existing) summary.overwritten++;
      else summary.added++;
    }
    set[scriptsKey(domain.id)] = scripts;
  }
  set.domains = domains;
  return { set, newOrigins, summary };
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run tests/archive.test.ts`
Expected: PASS (8개)

- [ ] **Step 5: 전체 테스트와 커밋**

Run: `npm test`
Expected: 전부 PASS

```bash
git add userscript-vault/src/lib/archive.ts userscript-vault/tests/archive.test.ts
git commit -m "feat: zip 내보내기/가져오기 로직"
```

---

### Task 9: 옵션 페이지 — 레이아웃, 도메인 목록, 도메인 추가/삭제

UI 자동 테스트 없음. 수동 확인.

**Files:**
- Create: `src/lib/dom.ts`, `src/options/confirm.ts`, `src/options/options.css`
- Modify: `src/options/options.html`, `src/options/options.ts` (Task 1 내용 전체 교체)

**Interfaces:**
- Consumes: `normalizeHost` (Task 2), `patternsFor`, `subdomainPattern` (Task 3), storage 함수들 (Task 4)
- Produces:
  - `dom.ts`: `el(tag, props?, ...children)`, `$<T extends HTMLElement>(selector: string): T`
  - `confirm.ts`: `confirmDialog(text: string, okLabel?: string): Promise<boolean>`
  - `options.ts`: 모듈 내부 상태 `state: { domainId: string | null; scriptId: string | null; dirty: boolean }`, 함수 `renderDomains()`, `selectDomain(id)`. Task 10, 11이 같은 파일을 확장한다.

- [ ] **Step 1: dom.ts 작성**

```ts
type Props<K extends keyof HTMLElementTagNameMap> = Partial<Omit<HTMLElementTagNameMap[K], "style" | "children">> & {
  class?: string;
  dataset?: Record<string, string>;
};

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props<K> = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { class: cls, dataset, ...rest } = props;
  if (cls) node.className = cls;
  if (dataset) Object.assign(node.dataset, dataset);
  Object.assign(node, rest);
  node.append(...children);
  return node;
}

export function $<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`요소 없음: ${selector}`);
  return node;
}

export function clear(node: HTMLElement): void {
  node.replaceChildren();
}
```

- [ ] **Step 2: confirm.ts 작성**

```ts
import { $ } from "../lib/dom";

export function confirmDialog(text: string, okLabel = "확인"): Promise<boolean> {
  const dialog = $<HTMLDialogElement>("#confirm-dialog");
  $("#confirm-text").textContent = text;
  $("#confirm-ok").textContent = okLabel;
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok"), { once: true });
    dialog.showModal();
  });
}
```

- [ ] **Step 3: options.html 작성 (Task 10·11에서 쓸 요소까지 한 번에)**

```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>userscript-vault</title>
    <link rel="stylesheet" href="./options.css" />
  </head>
  <body>
    <header id="banners" class="banners" aria-live="polite"></header>

    <main class="layout">
      <section class="col col-domains" aria-labelledby="domains-heading">
        <h2 id="domains-heading" class="col-title">도메인</h2>
        <form id="add-domain-form" class="add-form" autocomplete="off">
          <input id="add-domain-input" name="host" placeholder="example.com" aria-label="추가할 호스트" required />
          <button type="submit">추가</button>
        </form>
        <p id="add-domain-error" class="inline-error" role="alert" hidden></p>
        <ul id="domain-list" class="list"></ul>
        <footer class="col-footer">
          <button type="button" id="export-btn">내보내기</button>
          <label class="button">가져오기<input type="file" id="import-input" accept=".zip,application/zip" hidden /></label>
        </footer>
      </section>

      <section class="col col-scripts" aria-labelledby="scripts-heading">
        <div class="col-head">
          <h2 id="scripts-heading" class="col-title">스크립트</h2>
          <button type="button" id="add-script-btn" disabled>+ 새 스크립트</button>
        </div>
        <div id="domain-settings" class="domain-settings" hidden>
          <label><input type="checkbox" id="include-subdomains" /> 서브도메인 포함</label>
          <button type="button" id="delete-domain-btn" class="danger">도메인 삭제</button>
        </div>
        <ul id="script-list" class="list"></ul>
      </section>

      <section class="col col-editor" aria-labelledby="editor-heading">
        <h2 id="editor-heading" class="visually-hidden">에디터</h2>
        <div class="editor-head">
          <input id="script-name" placeholder="스크립트 이름" aria-label="스크립트 이름" disabled />
          <select id="run-at" aria-label="실행 시점" disabled>
            <option value="document_start">document_start</option>
            <option value="document_end">document_end</option>
            <option value="document_idle" selected>document_idle</option>
          </select>
          <select id="world" aria-label="실행 world" disabled>
            <option value="USER_SCRIPT" selected>USER_SCRIPT</option>
            <option value="MAIN">MAIN</option>
          </select>
          <button type="button" id="copy-script-btn" disabled>복사</button>
          <button type="button" id="delete-script-btn" class="danger" disabled>삭제</button>
          <button type="button" id="save-btn" class="primary" disabled>저장</button>
        </div>
        <div id="editor" class="editor"></div>
        <div id="status" class="status" aria-live="polite"></div>
      </section>
    </main>

    <dialog id="confirm-dialog">
      <p id="confirm-text"></p>
      <form method="dialog" class="dialog-actions">
        <button value="cancel">취소</button>
        <button value="ok" id="confirm-ok" class="primary">확인</button>
      </form>
    </dialog>

    <dialog id="conflict-dialog">
      <p>같은 이름의 스크립트가 이미 있을 때 어떻게 할까요?</p>
      <form method="dialog" class="dialog-actions">
        <button value="cancel">취소</button>
        <button value="skip">건너뛰기</button>
        <button value="overwrite" class="primary">덮어쓰기</button>
      </form>
    </dialog>

    <dialog id="copy-dialog">
      <p>어느 도메인으로 복사할까요?</p>
      <form method="dialog" class="dialog-actions">
        <select id="copy-target" aria-label="복사 대상 도메인"></select>
        <button value="cancel">취소</button>
        <button value="ok" class="primary">복사</button>
      </form>
    </dialog>

    <script type="module" src="./options.ts"></script>
  </body>
</html>
```

- [ ] **Step 4: options.css 작성**

```css
:root {
  color-scheme: light dark;
  --bg: #f6f6f4;
  --surface: #ffffff;
  --surface-2: #ededea;
  --border: #d9d9d4;
  --text: #1c1c1a;
  --text-muted: #6b6b66;
  --accent: #2d6cdf;
  --ok: #2f9e44;
  --off: #a0a09a;
  --danger: #d9480f;
  --warn: #e8890c;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
  --radius: 6px;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #141412;
    --surface: #1d1d1a;
    --surface-2: #26261f;
    --border: #33332e;
    --text: #e8e8e2;
    --text-muted: #8c8c84;
    --accent: #6ea0ff;
    --off: #5d5d57;
  }
}

* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body { font: 13px/1.45 var(--sans); color: var(--text); background: var(--bg); display: flex; flex-direction: column; }

.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }

.banners:empty { display: none; }
.banners { display: flex; flex-direction: column; gap: 1px; }
.banner { padding: var(--space-2) var(--space-4); font-size: 12px; }
.banner-warn { background: color-mix(in srgb, var(--warn) 18%, var(--surface)); border-bottom: 1px solid var(--warn); }
.banner-error { background: color-mix(in srgb, var(--danger) 16%, var(--surface)); border-bottom: 1px solid var(--danger); }
.banner code { font-family: var(--mono); }

.layout { flex: 1; display: grid; grid-template-columns: 220px 260px 1fr; min-height: 0; }
.col { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--border); background: var(--surface); }
.col-editor { border-right: 0; background: var(--bg); }
.col-title { margin: 0; padding: var(--space-3) var(--space-3) var(--space-2); font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-muted); }
.col-head { display: flex; align-items: center; justify-content: space-between; padding-right: var(--space-2); }

.add-form { display: flex; gap: var(--space-1); padding: 0 var(--space-2) var(--space-2); }
.add-form input { flex: 1; min-width: 0; }
.inline-error { margin: 0; padding: 0 var(--space-3) var(--space-2); color: var(--danger); font-size: 12px; }

.list { list-style: none; margin: 0; padding: 0; overflow-y: auto; flex: 1; }
.list-item { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-3); cursor: pointer; font-family: var(--mono); font-size: 12px; border-left: 2px solid transparent; }
.list-item:hover { background: var(--surface-2); }
.list-item.selected { background: var(--surface-2); border-left-color: var(--accent); }
.list-item .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.list-item .count { color: var(--text-muted); font-size: 11px; }
.list-item.has-error .name::after { content: " !"; color: var(--danger); font-weight: 700; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--off); flex: none; }
.dot.on { background: var(--ok); }
.empty { padding: var(--space-4) var(--space-3); color: var(--text-muted); font-size: 12px; }

.col-footer { display: flex; gap: var(--space-1); padding: var(--space-2); border-top: 1px solid var(--border); }
.col-footer > * { flex: 1; text-align: center; }

.domain-settings { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); padding: 0 var(--space-3) var(--space-2); font-size: 12px; }

.editor-head { display: flex; gap: var(--space-1); padding: var(--space-2); border-bottom: 1px solid var(--border); background: var(--surface); }
.editor-head #script-name { flex: 1; min-width: 0; font-family: var(--mono); }
.editor { flex: 1; min-height: 0; overflow: hidden; }
.editor .cm-editor { height: 100%; font-size: 13px; }
.editor .cm-scroller { font-family: var(--mono); }
.status { padding: var(--space-1) var(--space-3); font-size: 12px; color: var(--text-muted); border-top: 1px solid var(--border); background: var(--surface); min-height: 24px; }
.status.error { color: var(--danger); }
.status.warn { color: var(--warn); }

button, .button, input, select {
  font: inherit; color: inherit; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
  padding: var(--space-1) var(--space-2); cursor: pointer;
}
input, select { cursor: text; }
select { cursor: pointer; }
button:hover, .button:hover { background: var(--surface-2); }
button:focus-visible, input:focus-visible, select:focus-visible, .list-item:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
button:disabled { opacity: 0.45; cursor: default; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.primary:hover { filter: brightness(1.08); }
button.danger { color: var(--danger); }
input[type="checkbox"] { accent-color: var(--accent); cursor: pointer; }

dialog { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); color: var(--text); padding: var(--space-4); min-width: 320px; }
dialog::backdrop { background: rgb(0 0 0 / 0.35); }
.dialog-actions { display: flex; gap: var(--space-2); justify-content: flex-end; margin-top: var(--space-3); }

@media (max-width: 900px) {
  .layout { grid-template-columns: 1fr; grid-auto-rows: minmax(160px, auto) minmax(160px, auto) 1fr; }
  .col { border-right: 0; border-bottom: 1px solid var(--border); }
}
```

- [ ] **Step 5: options.ts 작성 (도메인 부분)**

```ts
import { el, $, clear } from "../lib/dom";
import { normalizeHost } from "../lib/host";
import { patternsFor, subdomainPattern } from "../lib/patterns";
import {
  readDomains, readScripts, addDomain, updateDomain, deleteDomain, DuplicateHostError,
} from "../lib/storage";
import type { Domain } from "../lib/types";
import { confirmDialog } from "./confirm";

interface State {
  domainId: string | null;
  scriptId: string | null;
  dirty: boolean;
}

const state: State = { domainId: null, scriptId: null, dirty: false };

const domainList = $<HTMLUListElement>("#domain-list");
const addDomainForm = $<HTMLFormElement>("#add-domain-form");
const addDomainInput = $<HTMLInputElement>("#add-domain-input");
const addDomainError = $<HTMLParagraphElement>("#add-domain-error");
const domainSettings = $<HTMLDivElement>("#domain-settings");
const includeSubdomains = $<HTMLInputElement>("#include-subdomains");
const deleteDomainBtn = $<HTMLButtonElement>("#delete-domain-btn");
const addScriptBtn = $<HTMLButtonElement>("#add-script-btn");

function showAddDomainError(message: string | null): void {
  addDomainError.textContent = message ?? "";
  addDomainError.hidden = message === null;
}

async function renderDomains(): Promise<void> {
  const domains = Object.values(await readDomains()).sort((a, b) => a.host.localeCompare(b.host));
  const counts = await Promise.all(domains.map(async (d) => Object.keys(await readScripts(d.id)).length));
  clear(domainList);
  if (domains.length === 0) {
    domainList.append(el("li", { class: "empty" }, "도메인을 추가하세요"));
    return;
  }
  domains.forEach((domain, i) => {
    const item = el(
      "li",
      { class: `list-item${domain.id === state.domainId ? " selected" : ""}`, tabIndex: 0, dataset: { id: domain.id } },
      el("span", { class: `dot${domain.enabled ? " on" : ""}`, title: domain.enabled ? "활성" : "비활성" }),
      el("span", { class: "name", title: domain.host }, domain.includeSubdomains ? `*.${domain.host}` : domain.host),
      el("span", { class: "count" }, String(counts[i] ?? 0)),
    );
    item.addEventListener("click", () => void selectDomain(domain.id));
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        void selectDomain(domain.id);
      }
    });
    domainList.append(item);
  });
}

async function currentDomain(): Promise<Domain | null> {
  if (!state.domainId) return null;
  return (await readDomains())[state.domainId] ?? null;
}

async function selectDomain(id: string | null): Promise<void> {
  if (state.dirty && !(await confirmDialog("저장하지 않은 변경이 있습니다. 버리고 이동할까요?", "버리기"))) return;
  state.domainId = id;
  state.scriptId = null;
  state.dirty = false;
  const domain = await currentDomain();
  domainSettings.hidden = domain === null;
  addScriptBtn.disabled = domain === null;
  if (domain) includeSubdomains.checked = domain.includeSubdomains;
  await renderDomains();
  await renderScripts(); // Task 10에서 정의. 지금은 아래 임시 정의 사용.
}

addDomainForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const result = normalizeHost(addDomainInput.value);
  if (!result.ok) {
    showAddDomainError(result.error === "empty" ? "호스트를 입력하세요" : "올바른 호스트가 아닙니다 (예: example.com)");
    return;
  }
  const origins = patternsFor({ host: result.host, includeSubdomains: false });
  // permissions.request는 사용자 제스처(transient activation) 안에서만 동작한다. submit 핸들러에서 다른 비동기 작업 없이 바로 호출.
  const granted = await chrome.permissions.request({ origins });
  if (!granted) {
    showAddDomainError("사이트 접근 권한이 필요합니다");
    return;
  }
  try {
    const domain = await addDomain({ host: result.host, includeSubdomains: false });
    showAddDomainError(null);
    addDomainInput.value = "";
    await selectDomain(domain.id);
  } catch (err) {
    showAddDomainError(err instanceof DuplicateHostError ? "이미 등록된 호스트입니다" : "추가하지 못했습니다");
  }
});

includeSubdomains.addEventListener("change", async () => {
  const domain = await currentDomain();
  if (!domain) return;
  if (includeSubdomains.checked) {
    const granted = await chrome.permissions.request({ origins: [subdomainPattern(domain.host)] });
    if (!granted) {
      includeSubdomains.checked = false;
      return;
    }
  } else {
    await chrome.permissions.remove({ origins: [subdomainPattern(domain.host)] });
  }
  await updateDomain(domain.id, { includeSubdomains: includeSubdomains.checked });
  await renderDomains();
});

deleteDomainBtn.addEventListener("click", async () => {
  const domain = await currentDomain();
  if (!domain) return;
  const count = Object.keys(await readScripts(domain.id)).length;
  const ok = await confirmDialog(`${domain.host} 도메인과 스크립트 ${count}개를 삭제할까요?`, "삭제");
  if (!ok) return;
  await chrome.permissions.remove({ origins: patternsFor(domain) });
  await deleteDomain(domain.id);
  state.dirty = false;
  await selectDomain(null);
});

// ---- Task 10에서 교체되는 임시 정의 ----
async function renderScripts(): Promise<void> {}

// ---- 부트스트랩 ----
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if ("domains" in changes || Object.keys(changes).some((k) => k.startsWith("scripts:"))) void renderDomains();
});

void (async () => {
  const params = new URLSearchParams(location.search);
  const add = params.get("add");
  if (add) addDomainInput.value = add;
  await renderDomains();
})();
```

- [ ] **Step 6: 빌드와 수동 확인**

Run: `npm run build`
Expected: 오류 없음

크롬에서 확장 새로고침 → 옵션 페이지:
1. 3단 레이아웃. 좌측 "도메인을 추가하세요".
2. `GitHub.com/foo` 입력 → 추가 → 크롬 권한 프롬프트 → 허용 → 목록에 `github.com`, 초록 점, 카운트 0, 선택됨. 가운데 열에 "서브도메인 포함" 체크박스와 "도메인 삭제".
3. 같은 호스트 재입력 → "이미 등록된 호스트입니다".
4. `nodots` 입력 → "올바른 호스트가 아닙니다".
5. 서브도메인 체크 → 두 번째 권한 프롬프트 → 허용 → 목록 표시가 `*.github.com`. 체크 해제 → 원복.
6. 권한 프롬프트에서 거부 → 도메인 생성 안 됨, "사이트 접근 권한이 필요합니다".
7. 도메인 삭제 → 확인 대화상자(취소/삭제) → 삭제 → 목록 비움. `chrome://extensions` 세부정보의 사이트 액세스에서 해당 사이트가 사라짐.
8. 시스템 다크 모드 전환 → 배경·텍스트 색 반전, 가독성 유지.

- [ ] **Step 7: 커밋**

```bash
git add userscript-vault/src/lib/dom.ts userscript-vault/src/options
git commit -m "feat: 옵션 페이지 레이아웃과 도메인 관리"
```

---

### Task 10: 옵션 페이지 — 스크립트 목록과 에디터

**Files:**
- Create: `src/options/editor.ts`
- Modify: `src/options/options.ts` (Task 9의 임시 `renderScripts` 교체, 에디터 로직 추가)

**Interfaces:**
- Consumes: `addScript`, `updateScriptMeta`, `saveCode`, `deleteScript`, `readCode`, `readScripts`, `readDomains` (Task 4), `findSyntaxError` (Task 7), `RUN_AT_VALUES`, `WORLD_VALUES` (Task 2)
- Produces: `editor.ts`: `createEditor(parent: HTMLElement, hooks: { onChange(): void; onSave(): void }): Editor` where `Editor = { getValue(): string; setValue(code: string): void; setEnabled(on: boolean): void }`

- [ ] **Step 1: editor.ts 작성**

```ts
import { EditorView, basicSetup } from "codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { keymap } from "@codemirror/view";
import { Compartment, EditorState, Prec } from "@codemirror/state";

export interface Editor {
  getValue(): string;
  setValue(code: string): void;
  setEnabled(on: boolean): void;
}

export function createEditor(parent: HTMLElement, hooks: { onChange(): void; onSave(): void }): Editor {
  const editable = new Compartment();
  let applyingExternal = false;

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: "",
      extensions: [
        basicSetup,
        javascript(),
        Prec.highest(keymap.of([{ key: "Mod-s", run: () => { hooks.onSave(); return true; } }])),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !applyingExternal) hooks.onChange();
        }),
        editable.of([EditorView.editable.of(false), EditorState.readOnly.of(true)]),
      ],
    }),
  });

  return {
    getValue: () => view.state.doc.toString(),
    setValue: (code) => {
      applyingExternal = true;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: code } });
      applyingExternal = false;
    },
    setEnabled: (on) => {
      view.dispatch({ effects: editable.reconfigure([EditorView.editable.of(on), EditorState.readOnly.of(!on)]) });
    },
  };
}
```

- [ ] **Step 2: options.ts에 스크립트·에디터 로직 추가**

import 줄에 추가:
```ts
import { addScript, updateScriptMeta, saveCode, deleteScript, readCode } from "../lib/storage";
import { RUN_AT_VALUES, WORLD_VALUES, type RunAt, type ScriptMeta, type World } from "../lib/types";
import { findSyntaxError } from "../lib/validate";
import { createEditor } from "./editor";
```
(기존 `../lib/storage` import와 합친다.)

`// ---- Task 10에서 교체되는 임시 정의 ----` 블록을 지우고 아래로 교체:

```ts
// ---- 스크립트 목록 ----
const scriptList = $<HTMLUListElement>("#script-list");
const scriptName = $<HTMLInputElement>("#script-name");
const runAtSelect = $<HTMLSelectElement>("#run-at");
const worldSelect = $<HTMLSelectElement>("#world");
const saveBtn = $<HTMLButtonElement>("#save-btn");
const deleteScriptBtn = $<HTMLButtonElement>("#delete-script-btn");
const copyScriptBtn = $<HTMLButtonElement>("#copy-script-btn");
const statusEl = $<HTMLDivElement>("#status");

const editor = createEditor($("#editor"), { onChange: markDirty, onSave: () => void saveCurrent() });

const RELOAD_HINT = "저장됨. 열려 있는 탭은 새로고침해야 반영됩니다.";

function setStatus(text: string, kind: "" | "warn" | "error" = ""): void {
  statusEl.textContent = text;
  statusEl.className = `status${kind ? ` ${kind}` : ""}`;
}

function markDirty(): void {
  state.dirty = true;
  saveBtn.disabled = false;
  setStatus("변경됨");
}

function setEditorEnabled(on: boolean): void {
  editor.setEnabled(on);
  for (const control of [scriptName, runAtSelect, worldSelect, deleteScriptBtn, copyScriptBtn]) control.disabled = !on;
  saveBtn.disabled = true;
}

async function currentScript(): Promise<ScriptMeta | null> {
  if (!state.domainId || !state.scriptId) return null;
  return (await readScripts(state.domainId))[state.scriptId] ?? null;
}

async function renderScripts(): Promise<void> {
  clear(scriptList);
  if (!state.domainId) {
    scriptList.append(el("li", { class: "empty" }, "도메인을 선택하세요"));
    await loadScript(null);
    return;
  }
  const scripts = Object.values(await readScripts(state.domainId)).sort((a, b) => a.name.localeCompare(b.name));
  if (scripts.length === 0) scriptList.append(el("li", { class: "empty" }, "스크립트가 없습니다"));
  for (const script of scripts) {
    const toggle = el("input", { type: "checkbox", checked: script.enabled, title: "활성/비활성" });
    toggle.addEventListener("click", (e) => e.stopPropagation());
    toggle.addEventListener("change", async () => {
      await updateScriptMeta(script.domainId, script.id, { enabled: toggle.checked });
      await renderScripts();
    });
    const item = el(
      "li",
      { class: `list-item${script.id === state.scriptId ? " selected" : ""}`, tabIndex: 0, dataset: { id: script.id } },
      toggle,
      el("span", { class: "name", title: script.name }, script.name),
    );
    item.addEventListener("click", () => void selectScript(script.id));
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        void selectScript(script.id);
      }
    });
    scriptList.append(item);
  }
  if (state.scriptId && !scripts.some((s) => s.id === state.scriptId)) await loadScript(null);
}

async function selectScript(id: string | null): Promise<void> {
  if (id === state.scriptId) return;
  if (state.dirty && !(await confirmDialog("저장하지 않은 변경이 있습니다. 버리고 이동할까요?", "버리기"))) return;
  await loadScript(id);
  await renderScripts();
}

async function loadScript(id: string | null): Promise<void> {
  state.scriptId = id;
  state.dirty = false;
  const script = await currentScript();
  if (!script) {
    editor.setValue("");
    scriptName.value = "";
    setEditorEnabled(false);
    setStatus("");
    return;
  }
  editor.setValue(await readCode(script.id));
  scriptName.value = script.name;
  runAtSelect.value = script.runAt;
  worldSelect.value = script.world;
  setEditorEnabled(true);
  setStatus("");
}

async function saveCurrent(): Promise<void> {
  const script = await currentScript();
  if (!script) return;
  const name = scriptName.value.trim() || script.name;
  const runAt = RUN_AT_VALUES.includes(runAtSelect.value as RunAt) ? (runAtSelect.value as RunAt) : script.runAt;
  const world = WORLD_VALUES.includes(worldSelect.value as World) ? (worldSelect.value as World) : script.world;
  const code = editor.getValue();
  try {
    await updateScriptMeta(script.domainId, script.id, { name, runAt, world });
    await saveCode(script.domainId, script.id, code);
  } catch (err) {
    setStatus(`저장 실패: ${err instanceof Error ? err.message : String(err)}`, "error");
    return;
  }
  state.dirty = false;
  saveBtn.disabled = true;
  const syntax = findSyntaxError(code);
  if (syntax) setStatus(`저장됨. 문법 오류: ${syntax.line}번째 줄 근처`, "error");
  else setStatus(RELOAD_HINT);
  await renderScripts();
}

addScriptBtn.addEventListener("click", async () => {
  if (!state.domainId) return;
  if (state.dirty && !(await confirmDialog("저장하지 않은 변경이 있습니다. 버리고 새로 만들까요?", "버리기"))) return;
  const existing = Object.keys(await readScripts(state.domainId)).length;
  const script = await addScript(state.domainId, `script-${existing + 1}`);
  await loadScript(script.id);
  await renderScripts();
  await renderDomains();
  scriptName.focus();
  scriptName.select();
});

saveBtn.addEventListener("click", () => void saveCurrent());
scriptName.addEventListener("input", markDirty);
runAtSelect.addEventListener("change", markDirty);
worldSelect.addEventListener("change", markDirty);

deleteScriptBtn.addEventListener("click", async () => {
  const script = await currentScript();
  if (!script) return;
  if (!(await confirmDialog(`"${script.name}" 스크립트를 삭제할까요?`, "삭제"))) return;
  await deleteScript(script.domainId, script.id);
  state.dirty = false;
  await loadScript(null);
  await renderScripts();
  await renderDomains();
});

copyScriptBtn.addEventListener("click", async () => {
  const script = await currentScript();
  if (!script) return;
  const dialog = $<HTMLDialogElement>("#copy-dialog");
  const target = $<HTMLSelectElement>("#copy-target");
  clear(target);
  const domains = Object.values(await readDomains()).sort((a, b) => a.host.localeCompare(b.host));
  for (const d of domains) target.append(el("option", { value: d.id, textContent: d.host }));
  const choice = await new Promise<string | null>((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok" ? target.value : null), { once: true });
    dialog.showModal();
  });
  if (!choice) return;
  const copy = await addScript(choice, script.name);
  await updateScriptMeta(choice, copy.id, { runAt: script.runAt, world: script.world, enabled: script.enabled });
  await saveCode(choice, copy.id, await readCode(script.id));
  setStatus(`"${script.name}"을(를) ${domains.find((d) => d.id === choice)?.host ?? ""}(으)로 복사했습니다`);
  await renderDomains();
  if (choice === state.domainId) await renderScripts();
});

window.addEventListener("beforeunload", (e) => {
  if (state.dirty) e.preventDefault();
});
```

`chrome.storage.onChanged` 리스너(Task 9 부트스트랩 블록)를 아래로 교체해 스크립트 열도 갱신:

```ts
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const keys = Object.keys(changes);
  if ("domains" in changes || keys.some((k) => k.startsWith("scripts:"))) void renderDomains();
  if (state.domainId && scriptsKey(state.domainId) in changes && !state.dirty) void renderScripts();
});
```
(`scriptsKey`를 `../lib/storage` import에 추가.)

- [ ] **Step 3: 빌드와 수동 확인**

Run: `npm run build`
Expected: 오류 없음

옵션 페이지:
1. 도메인 선택 → "+ 새 스크립트" → `script-1` 생성, 이름 입력창에 포커스·전체 선택. 에디터 활성, 상태줄 비움.
2. 에디터에 `document.title = "VAULT"` 입력 → 상태 "변경됨", 저장 버튼 활성. `Cmd+S` → 상태 "저장됨. 열려 있는 탭은 새로고침해야 반영됩니다." 저장 버튼 비활성.
3. 해당 도메인 페이지 새로고침 → 제목 바뀜.
4. 이름을 `dark`로 바꾸고 저장 → 목록 이름 갱신, 도메인 카운트 1.
5. 체크박스 해제 → 페이지 새로고침 → 실행 안 됨. 다시 체크 → 실행.
6. `const x = ;` 저장 → 상태 빨간색 "저장됨. 문법 오류: 1번째 줄 근처". 저장은 되어 있음(재선택 시 그대로).
7. 수정 후 저장 없이 다른 스크립트 클릭 → 대화상자(취소/버리기). 취소 → 유지. 버리기 → 이동.
8. world를 MAIN으로, 코드 `console.log(typeof window.jQuery)` → jQuery 쓰는 사이트에서 "function" 출력.
9. 복사 → 다른 도메인 선택 → 그 도메인에 같은 이름·코드·설정 스크립트.
10. 삭제 → 확인 → 목록에서 사라지고 에디터 비활성.
11. 저장 안 한 상태로 탭 닫기 → 브라우저 "나가시겠습니까" 경고.

- [ ] **Step 4: 커밋**

```bash
git add userscript-vault/src/options
git commit -m "feat: 스크립트 목록과 CodeMirror 에디터"
```

---

### Task 11: 옵션 페이지 — 가져오기/내보내기, 배너

**Files:**
- Create: `src/options/transfer.ts`, `src/options/banners.ts`
- Modify: `src/options/options.ts`

**Interfaces:**
- Consumes: `buildExport`, `parseImport`, `planImport`, `ConflictPolicy` (Task 8), `readAll`, `applyBatch`, `readErrors`, `readDomains` (Task 4)
- Produces:
  - `transfer.ts`: `exportAll(): Promise<void>`, `importFile(file: File): Promise<string>` (결과 요약 문장 반환, 취소 시 빈 문자열)
  - `banners.ts`: `renderBanners(): Promise<void>`

- [ ] **Step 1: transfer.ts 작성**

```ts
import { buildExport, parseImport, planImport, type ConflictPolicy } from "../lib/archive";
import { readAll, applyBatch } from "../lib/storage";
import { $ } from "../lib/dom";

function dateStamp(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export async function exportAll(): Promise<void> {
  const snapshot = await readAll();
  const now = new Date();
  const bytes = buildExport(snapshot, now);
  const blob = new Blob([bytes], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `userscript-vault-${dateStamp(now)}.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function askConflictPolicy(): Promise<ConflictPolicy | null> {
  const dialog = $<HTMLDialogElement>("#conflict-dialog");
  return new Promise((resolve) => {
    dialog.addEventListener(
      "close",
      () => resolve(dialog.returnValue === "overwrite" || dialog.returnValue === "skip" ? dialog.returnValue : null),
      { once: true },
    );
    dialog.showModal();
  });
}

export async function importFile(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const parsed = parseImport(bytes);
  if (!parsed.ok) return `가져오기 실패: ${parsed.error}`;

  const policy = await askConflictPolicy();
  if (!policy) return "";

  const snapshot = await readAll();
  const plan = planImport(parsed.value, snapshot, policy, Date.now());

  if (plan.newOrigins.length > 0) {
    // 대화상자 버튼 클릭의 transient activation(약 5초) 안이라 요청 가능. 새 도메인 전부를 한 번에 요청.
    // "This function must be called during a user gesture" 오류가 나면 readAll()을 대화상자 열기 전으로 옮긴다.
    const granted = await chrome.permissions.request({ origins: plan.newOrigins });
    if (!granted) return "가져오기 취소: 새 도메인의 사이트 접근 권한이 거부되었습니다";
  }

  await applyBatch(plan.set);
  const { added, overwritten, skipped } = plan.summary;
  const detail = parsed.value.skipped.length > 0 ? ` (건너뛴 항목: ${parsed.value.skipped.join("; ")})` : "";
  return `가져오기 완료: 추가 ${added}, 덮어쓰기 ${overwritten}, 건너뜀 ${skipped}${detail}`;
}
```

- [ ] **Step 2: banners.ts 작성**

```ts
import { el, $, clear } from "../lib/dom";
import { readErrors, readDomains } from "../lib/storage";

export async function renderBanners(): Promise<void> {
  const container = $<HTMLElement>("#banners");
  clear(container);

  if (typeof chrome.userScripts === "undefined") {
    container.append(
      el(
        "div",
        { class: "banner banner-warn" },
        "사용자 스크립트가 꺼져 있어 스크립트가 실행되지 않습니다. ",
        el("code", {}, "chrome://extensions"),
        " → userscript-vault 세부정보 → \"사용자 스크립트 허용\"을 켜세요 (Chrome 138 미만은 개발자 모드).",
      ),
    );
  }

  const [errors, domains] = await Promise.all([readErrors(), readDomains()]);
  for (const [domainId, message] of Object.entries(errors)) {
    const host = domains[domainId]?.host ?? domainId;
    container.append(el("div", { class: "banner banner-error" }, `${host}: ${message}`));
  }
}
```

- [ ] **Step 3: options.ts에 연결**

import 추가:
```ts
import { exportAll, importFile } from "./transfer";
import { renderBanners } from "./banners";
```

부트스트랩 블록 위에 추가:
```ts
$<HTMLButtonElement>("#export-btn").addEventListener("click", () => void exportAll());

const importInput = $<HTMLInputElement>("#import-input");
importInput.addEventListener("change", async () => {
  const file = importInput.files?.[0];
  importInput.value = "";
  if (!file) return;
  const message = await importFile(file);
  if (message) setStatus(message, message.startsWith("가져오기 실패") || message.startsWith("가져오기 취소") ? "error" : "");
  await renderDomains();
  await renderScripts();
});
```

`chrome.storage.onChanged` 리스너에 한 줄 추가:
```ts
  if ("errors" in changes) void renderBanners();
```

부트스트랩 async 함수 안 `await renderDomains();` 앞에 `await renderBanners();` 추가.

- [ ] **Step 4: 빌드와 수동 확인**

Run: `npm run build`
Expected: 오류 없음

1. "사용자 스크립트 허용" 토글을 끄고 옵션 페이지 새로고침 → 주황 배너. 다시 켜고 새로고침 → 사라짐.
2. 도메인 2개, 스크립트 3개 상태에서 내보내기 → `userscript-vault-2026-10-07.zip` 다운로드. 압축 풀면 `export.json` + `<host>/<name>.js`.
3. `chrome://extensions`에서 확장 제거 → 다시 로드 → 가져오기 → 충돌 대화상자(취소/건너뛰기/덮어쓰기) → 덮어쓰기 → 권한 프롬프트(새 도메인 2개 한 번에) → 허용 → 상태줄 "가져오기 완료: 추가 3, 덮어쓰기 0, 건너뜀 0". 도메인·스크립트·코드·설정 복원. 해당 사이트에서 실행.
4. 같은 zip 다시 가져오기 → 건너뛰기 → "추가 0, 덮어쓰기 0, 건너뜀 3". 덮어쓰기 → "추가 0, 덮어쓰기 3, 건너뜀 0".
5. 아무 텍스트 파일을 `.zip`으로 이름 바꿔 가져오기 → "가져오기 실패: zip 파일을 읽을 수 없습니다".
6. 권한 프롬프트 거부 → "가져오기 취소: …", storage 변화 없음(도메인 목록 그대로).
7. 호스트 권한을 `chrome://extensions` 사이트 액세스에서 수동 제거 → 100ms 뒤 옵션 페이지에 빨간 배너 `host: 호스트 권한이 없습니다…`. 도메인 삭제 후 재추가 → 배너 사라짐.

- [ ] **Step 5: 커밋**

```bash
git add userscript-vault/src/options
git commit -m "feat: zip 가져오기/내보내기와 상태 배너"
```

---

### Task 12: 팝업

**Files:**
- Create: `src/popup/popup.css`
- Modify: `src/popup/popup.html`, `src/popup/popup.ts` (Task 1 내용 전체 교체)

**Interfaces:**
- Consumes: `readDomains`, `readScripts`, `updateDomain`, `updateScriptMeta` (Task 4), `hostMatches` (Task 3), `el`, `$`, `clear` (Task 9)

- [ ] **Step 1: popup.html 작성**

```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <title>userscript-vault</title>
    <link rel="stylesheet" href="./popup.css" />
  </head>
  <body>
    <header class="head">
      <span id="host" class="host">…</span>
      <button type="button" id="open-options" title="관리 열기">관리</button>
    </header>
    <div id="banner" class="banner" hidden></div>
    <main id="content" class="content"></main>
    <script type="module" src="./popup.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: popup.css 작성**

```css
:root {
  color-scheme: light dark;
  --bg: #ffffff; --surface-2: #f0f0ed; --border: #d9d9d4; --text: #1c1c1a; --text-muted: #6b6b66;
  --accent: #2d6cdf; --ok: #2f9e44; --off: #a0a09a; --warn: #e8890c;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #1d1d1a; --surface-2: #26261f; --border: #33332e; --text: #e8e8e2; --text-muted: #8c8c84; --accent: #6ea0ff; --off: #5d5d57; }
}
* { box-sizing: border-box; }
body { width: 320px; margin: 0; font: 13px/1.45 var(--sans); color: var(--text); background: var(--bg); }
.head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--border); }
.host { font-family: var(--mono); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.banner { padding: 8px 12px; font-size: 12px; background: color-mix(in srgb, var(--warn) 18%, var(--bg)); border-bottom: 1px solid var(--warn); }
.content { padding: 6px 0; }
.domain { padding: 4px 0; }
.domain + .domain { border-top: 1px solid var(--border); margin-top: 4px; padding-top: 8px; }
.row { display: flex; align-items: center; gap: 8px; padding: 6px 12px; }
.row.domain-row { font-weight: 600; }
.row.script-row { padding-left: 28px; font-family: var(--mono); font-size: 12px; }
.row .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row.disabled .name { color: var(--text-muted); }
.empty { padding: 16px 12px; color: var(--text-muted); font-size: 12px; }
.actions { padding: 6px 12px 10px; }
button { font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 4px 8px; cursor: pointer; }
button:hover { background: var(--surface-2); }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; width: 100%; }
button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
input[type="checkbox"] { accent-color: var(--accent); margin: 0; cursor: pointer; }
```

- [ ] **Step 3: popup.ts 작성**

```ts
import { el, $, clear } from "../lib/dom";
import { hostMatches } from "../lib/patterns";
import { readDomains, readScripts, updateDomain, updateScriptMeta } from "../lib/storage";
import type { Domain } from "../lib/types";

const hostEl = $<HTMLSpanElement>("#host");
const banner = $<HTMLDivElement>("#banner");
const content = $<HTMLElement>("#content");

async function currentHost(): Promise<string | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return null;
  try {
    const url = new URL(tab.url);
    return url.protocol === "http:" || url.protocol === "https:" ? url.hostname : null;
  } catch {
    return null;
  }
}

function optionsUrl(addHost?: string): string {
  const base = chrome.runtime.getURL("src/options/options.html");
  return addHost ? `${base}?add=${encodeURIComponent(addHost)}` : base;
}

function toggle(checked: boolean, onChange: (next: boolean) => Promise<void>): HTMLInputElement {
  const input = el("input", { type: "checkbox", checked });
  input.addEventListener("change", () => void onChange(input.checked));
  return input;
}

async function renderDomain(domain: Domain): Promise<HTMLElement> {
  const scripts = Object.values(await readScripts(domain.id)).sort((a, b) => a.name.localeCompare(b.name));
  const box = el("section", { class: "domain" });
  box.append(
    el(
      "div",
      { class: `row domain-row${domain.enabled ? "" : " disabled"}` },
      toggle(domain.enabled, async (next) => {
        await updateDomain(domain.id, { enabled: next });
        await render();
      }),
      el("span", { class: "name" }, domain.includeSubdomains ? `*.${domain.host}` : domain.host),
    ),
  );
  if (scripts.length === 0) box.append(el("div", { class: "empty" }, "스크립트 없음"));
  for (const script of scripts) {
    box.append(
      el(
        "div",
        { class: `row script-row${script.enabled && domain.enabled ? "" : " disabled"}` },
        toggle(script.enabled, async (next) => {
          await updateScriptMeta(domain.id, script.id, { enabled: next });
          await render();
        }),
        el("span", { class: "name", title: script.name }, script.name),
      ),
    );
  }
  return box;
}

async function render(): Promise<void> {
  banner.hidden = typeof chrome.userScripts !== "undefined";
  banner.textContent = "사용자 스크립트가 꺼져 있습니다. 관리 페이지의 안내를 따라 켜세요.";

  const host = await currentHost();
  clear(content);
  if (!host) {
    hostEl.textContent = "—";
    content.append(el("div", { class: "empty" }, "여기서는 사용할 수 없습니다"));
    return;
  }
  hostEl.textContent = host;
  hostEl.title = host;

  const matched = Object.values(await readDomains())
    .filter((d) => hostMatches(d, host))
    .sort((a, b) => b.host.length - a.host.length);

  if (matched.length === 0) {
    const add = el("button", { class: "primary", type: "button" }, `${host} 추가`);
    add.addEventListener("click", () => void chrome.tabs.create({ url: optionsUrl(host) }));
    content.append(el("div", { class: "empty" }, "이 사이트에 스크립트가 없습니다"), el("div", { class: "actions" }, add));
    return;
  }
  for (const domain of matched) content.append(await renderDomain(domain));
}

$("#open-options").addEventListener("click", () => void chrome.runtime.openOptionsPage());
void render();
```

- [ ] **Step 4: 빌드와 수동 확인**

Run: `npm run build`
Expected: 오류 없음

1. 등록된 도메인 페이지에서 아이콘 클릭 → 호스트명, 도메인 토글, 스크립트 토글 목록.
2. 스크립트 토글 끄기 → 페이지 새로고침 → 실행 안 됨. 옵션 페이지가 열려 있었다면 거기 체크박스도 바뀜.
3. 도메인 토글 끄기 → 하위 스크립트 이름 회색.
4. 미등록 사이트 → "이 사이트에 스크립트가 없습니다" + "`host` 추가" 버튼 → 옵션 페이지가 열리고 입력창에 호스트가 채워져 있음.
5. `chrome://extensions` 탭에서 클릭 → "여기서는 사용할 수 없습니다".
6. 서브도메인 포함 도메인은 `gist.github.com`에서도 뜸.
7. 사용자 스크립트 토글을 끈 상태 → 주황 배너.
8. "관리" 버튼 → 옵션 페이지.

- [ ] **Step 5: 커밋**

```bash
git add userscript-vault/src/popup
git commit -m "feat: 현재 탭 도메인 스크립트 토글 팝업"
```

---

### Task 13: 프라이버시 검사 스크립트, 수동 QA 문서, README

**Files:**
- Create: `scripts/check-privacy.sh`, `docs/manual-qa.md`, `README.md`
- Modify: `../README.md` (idea-bank 루트, 상태 열)

- [ ] **Step 1: check-privacy.sh 작성**

```sh
#!/usr/bin/env sh
# 확장이 외부와 통신하거나 sync 저장소를 쓰는 코드가 없는지 검사한다.
set -eu
cd "$(dirname "$0")/.."

fail=0

if grep -rnE 'storage\.sync|fetch\(|XMLHttpRequest|WebSocket|sendBeacon' src/; then
  echo "FAIL: src/ 에 네트워크 또는 sync 사용 흔적" >&2
  fail=1
fi

if grep -q '"host_permissions"' manifest.json; then
  echo "FAIL: manifest.json 에 정적 host_permissions" >&2
  fail=1
fi

if [ -d dist ]; then
  # match pattern(*://)과 SVG/XML 네임스페이스는 허용
  if grep -rhoE 'https?://[^"'"'"' )]+' dist/ | grep -vE '^https?://www\.w3\.org/' | sort -u | grep .; then
    echo "FAIL: dist/ 에 외부 URL 문자열" >&2
    fail=1
  fi
else
  echo "참고: dist/ 없음. npm run build 후 다시 실행하면 산출물도 검사한다."
fi

if [ "$fail" -eq 0 ]; then echo "privacy check OK"; fi
exit "$fail"
```

- [ ] **Step 2: 실행**

Run: `chmod +x scripts/check-privacy.sh && npm run build && npm run check:privacy`
Expected: `privacy check OK`. 실패하면 출력된 파일·줄을 보고 원인을 제거한다. CodeMirror 번들에 `http://` 문자열이 있으면 그 URL이 실제 네트워크 요청인지 확인하고(대부분 문서 링크나 네임스페이스), 요청이 아니면 allow 목록(`grep -vE`)에 해당 호스트를 추가하고 그 이유를 스크립트 주석으로 남긴다.

- [ ] **Step 3: docs/manual-qa.md 작성**

```markdown
# 수동 QA 체크리스트

새 빌드마다 아래를 훑는다. 각 항목은 Task 6, 9~12의 수동 확인을 모은 것.

## 준비
- [ ] `npm test`, `npm run build`, `npm run check:privacy` 전부 통과
- [ ] `chrome://extensions`에서 `dist/` 로드, "사용자 스크립트 허용" 켜짐

## 실행 엔진
- [ ] 도메인 추가 → 스크립트 작성·저장 → 탭 새로고침 → 실행
- [ ] 도메인 off / 스크립트 off 각각 → 실행 안 됨
- [ ] 서브도메인 체크 → 권한 프롬프트 → `sub.host`에서 실행
- [ ] world MAIN → 페이지 전역 변수 접근
- [ ] runAt document_start → `document.body`가 아직 null
- [ ] 확장 "새로고침" 후 스크립트 여전히 실행 (onInstalled 재동기화)
- [ ] 브라우저 완전 재시작 후 스크립트 여전히 실행

## 옵션 페이지
- [ ] 잘못된 호스트, 중복 호스트, 권한 거부 각각 올바른 메시지
- [ ] 저장 안 한 변경 상태에서 이동 시 확인 대화상자
- [ ] 문법 오류 저장 시 빨간 상태줄, 코드는 보존
- [ ] 복사 / 삭제 / 도메인 삭제(권한 반납 포함)
- [ ] 라이트·다크 모드 둘 다 가독성

## 가져오기 / 내보내기
- [ ] 내보내기 zip 구조: `export.json` + `<host>/<name>.js`
- [ ] 확장 제거 → 재설치 → 가져오기 → 동일 동작
- [ ] 같은 zip 재가져오기: 건너뛰기 / 덮어쓰기 요약 숫자 정확
- [ ] 손상 zip → 실패 메시지, storage 변화 없음
- [ ] 권한 거부 → 취소 메시지, storage 변화 없음

## 팝업
- [ ] 등록 도메인: 토글 동작, 옵션 페이지와 동기화
- [ ] 미등록 도메인: 추가 버튼 → 옵션 페이지에 호스트 채워짐
- [ ] chrome:// 탭: "여기서는 사용할 수 없습니다"

## 프라이버시
- [ ] DevTools → 서비스 워커 콘솔 → Network 탭: 요청 0건
- [ ] 옵션 페이지 DevTools Network 탭: 요청 0건 (확장 내부 파일 제외)
- [ ] `chrome://extensions` 세부정보 → 사이트 액세스: 등록한 도메인만
```

- [ ] **Step 4: userscript-vault/README.md 작성**

````markdown
# userscript-vault

외부 유출 없는 개인용 사용자 스크립트 관리자. Tampermonkey 대체.

- 도메인(호스트명) 하나에 스크립트 여러 개. 서브도메인 포함 옵션.
- MV3 `chrome.userScripts`로 실행. Chrome 120+.
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
```

문서: `docs/superpowers/specs/` (설계), `docs/superpowers/plans/` (구현 플랜), `docs/manual-qa.md` (수동 QA).
````

- [ ] **Step 5: 루트 README 상태 갱신**

`idea-bank/README.md`의 userscript-vault 행 상태 열을 `구현 완료 (v0.1.0)`으로 바꾼다.

- [ ] **Step 6: 전체 검증과 커밋**

Run (userscript-vault 안에서): `npm test && npm run build && npm run check:privacy`
Expected: 전부 통과

`docs/manual-qa.md` 전 항목 수행.

```bash
git add userscript-vault README.md
git commit -m "docs: userscript-vault 프라이버시 검사, 수동 QA, README"
```

---

## Self-Review 기록

**Spec 커버리지:**
- §3 아키텍처·manifest → Task 1, 6. `vite.config.ts`의 `type: "module"` background는 manifest에서 지정.
- §4 데이터 모델·규칙 → Task 2(타입·정규화), Task 4(storage, 삭제 캐스케이드, 불변 쓰기, 중복 거부).
- §5 실행 엔진: patterns → Task 3, registry → Task 5, 전체 교체·디바운스·onInstalled·권한 이벤트·userScripts 없음 처리·도메인 단위 폴백 → Task 6, 호스트 권한 흐름 → Task 9(추가·서브도메인·삭제 반납), Task 11(가져오기 일괄 요청).
- §6 UI: 팝업 → Task 12, 옵션 3단·에디터·저장·확인 대화상자·배너·디자인 토큰 → Task 9~11.
- §7 가져오기/내보내기 → Task 8(로직), Task 11(UI). 충돌 정책, 권한 거부 시 전체 중단, 한 번의 `set`.
- §8 오류 처리 표 → Task 6(`errors` 키), Task 9(권한 거부, 잘못된 호스트), Task 10(문법 오류, 저장 실패), Task 11(zip 손상, 권한 거부), Task 12(탭 URL 없음).
- §9 보안 체크리스트 → Task 13 `check-privacy.sh` + `manual-qa.md`.
- §10 테스트 → Task 2, 3, 4, 5, 7, 8 vitest. 수동 → Task 13.
- §11 spike → spike 1은 플랜 작성 중 Chrome 문서로 확인 완료(호스트 권한 필요). spike 2 → Task 1 Step 6에 대체 경로 포함.
- spec §5의 `buildRegistrations` 반환형은 `{registrations, missingPermission}`였으나 도메인 단위 폴백을 위해 `{groups, missingPermission}`으로 바꿨다. spec을 이에 맞게 수정한다.

**타입 일관성:** `scriptsKey`/`codeKey`(Task 4) → Task 8, 10, 11에서 동일 이름. `Registration`/`RegistrationGroup`(Task 5) → Task 6. `ParsedImport`/`ImportPlan`/`ConflictPolicy`(Task 8) → Task 11. `el`/`$`/`clear`(Task 9) → Task 10~12. `setStatus`/`renderScripts`/`renderDomains`(Task 9~10) → Task 11.

**Review Focus 매핑:** 1 → Task 2 테스트(`localhost:3000`, `Example.com:8080`). 2 → Task 8 `buildExport` 테스트(`x/y`, `x_y`, `...`). 3 → Task 5 `shouldResync`. 4 → Task 5 "skips when domain disabled…". 5 → Task 8 `parseImport` 테스트(`gone.js`, `whenever`, `MARS`).
