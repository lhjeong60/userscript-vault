import { test as base, chromium, expect, type BrowserContext, type Page } from "playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const DIST_E2E = resolve("dist-e2e");
const PAGE_HTML = `<!doctype html><html><head><title>plain</title></head><body><h1>test page</h1><script>window.pageGlobal = 42;</script></body></html>`;

export interface Ext {
  context: BrowserContext;
  id: string;
  // 확장에는 백그라운드 서비스워커가 없다. chrome.* 호출은 상시 열어 둔 확장 페이지에서 evaluate 한다.
  ext: () => Page;
  optionsUrl: string;
  popupUrl: string;
  siteUrl: string;
}

// chrome://extensions는 shadow DOM 트리라 id로 깊이 탐색한다.
function findInExtensionsPage(page: Page, targetId: string, innerSelector?: string) {
  return page.evaluate(
    ([targetId, inner]) => {
      const find = (root: Document | ShadowRoot): Element | null => {
        for (const el of root.querySelectorAll("*")) {
          if (el.id === targetId) return el;
          if (el.shadowRoot) {
            const hit = find(el.shadowRoot);
            if (hit) return hit;
          }
        }
        return null;
      };
      const host = find(document);
      const target = inner ? host?.shadowRoot?.querySelector<HTMLElement>(inner) : (host as HTMLElement | null);
      target?.click();
      return target !== null && target !== undefined;
    },
    [targetId, innerSelector] as const,
  );
}

async function readExtensionId(page: Page): Promise<string> {
  await page.goto("chrome://extensions/");
  return page.evaluate(() => {
    const walk = (root: Document | ShadowRoot): string | null => {
      for (const el of root.querySelectorAll("*")) {
        if (el.tagName.toLowerCase() === "extensions-item" && el.id) return el.id;
        if (el.shadowRoot) {
          const hit = walk(el.shadowRoot);
          if (hit) return hit;
        }
      }
      return null;
    };
    const id = walk(document);
    if (!id) throw new Error("확장 id를 찾지 못했습니다");
    return id;
  });
}

export const test = base.extend<{ ext: Ext }>({
  // eslint-disable-next-line no-empty-pattern
  ext: async ({}, use) => {
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE_HTML);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;

    const userDataDir = mkdtempSync(join(tmpdir(), "userscript-vault-e2e-"));
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: "chromium",
      headless: true,
      args: [`--disable-extensions-except=${DIST_E2E}`, `--load-extension=${DIST_E2E}`],
    });

    const setup = await context.newPage();
    const id = await readExtensionId(setup);
    await setup.goto(`chrome://extensions/?id=${id}`);
    await setup.waitForTimeout(300);
    const ok = await findInExtensionsPage(setup, "allow-user-scripts", "cr-toggle");
    if (!ok) throw new Error("allow-user-scripts 토글을 찾지 못함");
    await setup.close();

    // 상시 열어 두는 확장 페이지. chrome.userScripts / chrome.tabs 호출의 컨텍스트.
    const extPage = await context.newPage();
    await extPage.goto(`chrome-extension://${id}/src/options/options.html`);
    await expect.poll(() => extPage.evaluate(() => typeof chrome.userScripts !== "undefined"), { timeout: 10_000 }).toBe(true);

    const ext: Ext = {
      context,
      id,
      ext: () => extPage,
      optionsUrl: `chrome-extension://${id}/src/options/options.html`,
      popupUrl: `chrome-extension://${id}/src/popup/popup.html`,
      siteUrl: `http://localhost:${port}/`,
    };
    await use(ext);
    await context.close();
    await new Promise<void>((r) => server.close(() => r()));
  },
});

export function attachDebug(page: Page, label: string): void {
  page.on("pageerror", (e) => console.log(`[${label} pageerror]`, e.message));
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") console.log(`[${label} console.${m.type()}]`, m.text());
  });
}

export { expect };

/** 자동 등록은 없다. getScripts는 항상 비어 있어야 한다. */
export async function registeredCount(ext: Ext): Promise<number> {
  return (await ext.ext().evaluate(() => chrome.userScripts.getScripts())).length;
}

/** 팝업 runOnce가 쓰는 execute 경로를 확장 페이지에서 직접 호출한다. */
export async function executeOnSiteTab(ext: Ext, code: string, world: "USER_SCRIPT" | "MAIN"): Promise<string | undefined> {
  return ext.ext().evaluate(
    async ([code, world]) => {
      const tabs = await chrome.tabs.query({ url: "http://localhost/*" });
      const tabId = tabs[0]?.id;
      if (tabId === undefined) throw new Error("대상 탭을 찾지 못함");
      const r = await chrome.userScripts.execute({
        js: [{ code }],
        target: { tabId },
        world: world as chrome.userScripts.ExecutionWorld,
        injectImmediately: true,
      });
      return r[0]?.error;
    },
    [code, world] as const,
  );
}

export async function addDomainViaUi(page: Page, input: string, expectedHost = input): Promise<void> {
  const onboarding = page.locator("#onboarding-add-btn");
  if (await onboarding.isVisible()) await onboarding.click();
  else await page.click("#add-domain-btn");
  await expect(page.locator("#domain-dialog")).toBeVisible();
  await page.fill("#domain-host", input);
  await page.click("#domain-submit-btn");
  await expect(page.locator("#domain-dialog")).toBeHidden();
  await expect(page.locator("#domain-list .list-item.selected .name")).toHaveText(expectedHost);
}

export async function addScriptViaUi(page: Page, name: string, code: string, world?: "MAIN"): Promise<void> {
  await page.click("#add-script-btn");
  await expect(page.locator(".pane-editor")).toBeVisible();
  await page.fill("#script-name", name);
  if (world) await page.selectOption("#world", world);
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(code);
  await page.click("#save-btn");
  await expect(page.locator("#status")).toContainText("저장됨");
}

export function scriptRow(page: Page, name: string) {
  return page.locator("#script-list .list-item", { has: page.locator(".name", { hasText: new RegExp(`^${name}$`) }) });
}
