import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import {
  test, expect, addDomainViaUi, addScriptViaUi, scriptRow, registeredCount, executeOnSiteTab, attachDebug, type Ext,
} from "./fixtures";

const TITLE_SCRIPT = `document.title = "EXEC:" + typeof window.pageGlobal;`;

async function openOptions(ext: Ext) {
  const page = await ext.context.newPage();
  attachDebug(page, "options");
  await page.goto(ext.optionsUrl);
  await expect(page.locator("#layout")).toBeVisible();
  return page;
}

async function siteTitle(ext: Ext): Promise<string> {
  const page = await ext.context.newPage();
  await page.goto(ext.siteUrl);
  await page.waitForLoadState("load");
  await page.waitForTimeout(300);
  const title = await page.title();
  await page.close();
  return title;
}

test("단계별 노출: 도메인 없음 → 온보딩만, 도메인 선택 → 스크립트, 스크립트 선택 → 에디터", async ({ ext }) => {
  const page = await openOptions(ext);
  await expect(page.locator("#layout")).toHaveAttribute("data-stage", "empty");
  await expect(page.locator("#onboarding")).toBeVisible();
  await expect(page.locator(".pane-scripts")).toBeHidden();
  await expect(page.locator(".pane-editor")).toBeHidden();

  await addDomainViaUi(page, "localhost");
  await expect(page.locator("#layout")).toHaveAttribute("data-stage", "scripts");
  await expect(page.locator(".pane-scripts")).toBeVisible();
  await expect(page.locator("#scripts-heading")).toHaveText("localhost");
  await expect(page.locator(".pane-editor")).toBeHidden();

  await page.click("#add-script-btn");
  await expect(page.locator("#layout")).toHaveAttribute("data-stage", "editor");
  await expect(page.locator(".pane-editor")).toBeVisible();
  // 자동 실행 관련 컨트롤은 존재하지 않는다
  await expect(page.locator("#auto-run")).toHaveCount(0);
  await expect(page.locator("#manual-only")).toHaveCount(0);
  await expect(page.locator("#run-at")).toHaveCount(0);
});

test("스크립트는 자동 실행되지 않는다: 저장해도 등록 0, 페이지 로드로는 실행 안 됨", async ({ ext }) => {
  const page = await openOptions(ext);
  await addDomainViaUi(page, "localhost");
  await addScriptViaUi(page, "title", TITLE_SCRIPT);
  await page.waitForTimeout(400);
  expect(await registeredCount(ext)).toBe(0); // 등록이라는 개념 자체가 없다
  expect(await siteTitle(ext)).toBe("plain"); // 페이지를 열어도 실행되지 않음

  // 목록에 토글/배지 없음, 삭제 버튼만
  await expect(scriptRow(page, "title").locator(".switch")).toHaveCount(0);
  await expect(scriptRow(page, "title").locator("input[type=checkbox]")).toHaveCount(0);
});

test("팝업 execute 경로로만 실행된다 (USER_SCRIPT 격리, MAIN 전역 접근)", async ({ ext }) => {
  // 확장 페이지에서 execute = 팝업 '실행' 버튼이 호출하는 바로 그 경로
  const site = await ext.context.newPage();
  await site.goto(ext.siteUrl);
  await site.waitForLoadState("load");

  expect(await executeOnSiteTab(ext, TITLE_SCRIPT, "USER_SCRIPT")).toBeUndefined();
  await expect.poll(() => site.title()).toBe("EXEC:undefined"); // 격리 world: 페이지 전역 안 보임

  expect(await executeOnSiteTab(ext, TITLE_SCRIPT, "MAIN")).toBeUndefined();
  await expect.poll(() => site.title()).toBe("EXEC:number"); // MAIN: 페이지 전역 보임
  await site.close();
});

test("도메인 편집: 호스트·서브도메인 변경이 반영되고, 삭제 확인창의 Esc는 취소다", async ({ ext }) => {
  const page = await openOptions(ext);
  await addDomainViaUi(page, "localhost");
  await addScriptViaUi(page, "one", "1;");
  await addScriptViaUi(page, "two", "2;");

  await page.locator("#domain-list .list-item.selected .row-btn").click();
  await expect(page.locator("#domain-dialog-title")).toHaveText("도메인 편집");
  await page.locator("#domain-subdomains").check();
  await expect(page.locator("#domain-subdomains-preview")).toHaveText("*.localhost");
  await page.click("#domain-submit-btn");
  await expect(page.locator("#domain-list .list-item.selected .name")).toHaveText("*.localhost");

  // 스크립트 삭제를 확인(OK)으로 한 번 닫은 뒤…
  await scriptRow(page, "one").hover();
  await scriptRow(page, "one").locator(".row-btn").click();
  await page.click("#confirm-dialog #confirm-ok");
  await expect(page.locator("#script-list .list-item")).toHaveCount(1);

  // …도메인 삭제 확인창을 Esc로 닫으면 취소여야 한다 (returnValue 잔존 회귀)
  await page.locator("#domain-list .list-item.selected .row-btn").click();
  await page.click("#domain-delete-btn");
  await expect(page.locator("#confirm-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#confirm-dialog")).toBeHidden();
  await expect(page.locator("#domain-dialog")).toBeVisible();
  await page.click("#domain-cancel-btn");
  await expect(page.locator("#domain-list .list-item")).toHaveCount(1);

  // 진짜 삭제
  await page.locator("#domain-list .list-item.selected .row-btn").click();
  await page.click("#domain-delete-btn");
  await page.click("#confirm-dialog #confirm-ok");
  await expect(page.locator("#layout")).toHaveAttribute("data-stage", "empty");
});

test("저장하지 않은 변경이 있으면 이동 전에 확인하고, 도메인을 바꾸면 에디터가 닫힌다", async ({ ext }) => {
  const page = await openOptions(ext);
  await addDomainViaUi(page, "localhost");
  await addScriptViaUi(page, "a", "1;");
  await addScriptViaUi(page, "b", "2;");

  await page.locator(".cm-content").click();
  await page.keyboard.insertText("// edit");
  await expect(page.locator("#status")).toHaveText("변경됨");

  await scriptRow(page, "a").click();
  await expect(page.locator("#confirm-dialog")).toBeVisible();
  await page.click("#confirm-dialog button[value=cancel]");
  await expect(page.locator("#script-list .list-item.selected .name")).toHaveText("b");
  await expect(page.locator("#status")).toHaveText("변경됨");

  await scriptRow(page, "a").click();
  await page.click("#confirm-dialog #confirm-ok");
  await expect(page.locator("#script-list .list-item.selected .name")).toHaveText("a");

  await addDomainViaUi(page, "example.com");
  await expect(page.locator("#layout")).toHaveAttribute("data-stage", "scripts");
  await expect(page.locator(".pane-editor")).toBeHidden();
});

test("내보내기 zip을 초기화된 저장소에 가져오면 스크립트와 world가 복원된다", async ({ ext }) => {
  const page = await openOptions(ext);
  await addDomainViaUi(page, "localhost");
  await addScriptViaUi(page, "title", TITLE_SCRIPT, "MAIN");
  await addScriptViaUi(page, "title", "3;"); // 동명 스크립트도 왕복에서 보존 (리뷰 C2)

  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#export-btn")]);
  expect(download.suggestedFilename()).toMatch(/^userscript-vault-\d{4}-\d{2}-\d{2}\.zip$/);
  const zipPath = join(mkdtempSync(join(tmpdir(), "uv-export-")), "export.zip");
  await download.saveAs(zipPath);
  const files = unzipSync(new Uint8Array(readFileSync(zipPath)));
  const manifest = JSON.parse(strFromU8(files["export.json"]!)) as { domains: Array<{ host: string; scripts: Array<{ file: string; world: string }> }> };
  expect(manifest.domains[0]?.host).toBe("localhost");
  expect(manifest.domains[0]?.scripts.map((s) => s.file).sort()).toEqual(["localhost/title-2.js", "localhost/title.js"]);
  expect(manifest.domains[0]?.scripts.some((s) => s.world === "MAIN")).toBe(true);

  await page.evaluate(() => chrome.storage.local.clear());
  await page.reload();
  await expect(page.locator("#layout")).toHaveAttribute("data-stage", "empty");

  await page.setInputFiles("#import-input", zipPath);
  await expect(page.locator("#conflict-dialog")).toBeVisible();
  await page.click("#conflict-dialog button[value=overwrite]");
  await expect(page.locator("#conflict-dialog")).toBeHidden();
  await expect(page.locator("#banners")).toContainText("가져오기 완료: 추가 2, 덮어쓰기 0, 건너뜀 0");
  await expect(page.locator("#domain-list .list-item .name")).toHaveText("localhost");
  await page.locator("#domain-list .list-item").click();
  await expect(page.locator("#script-list .list-item")).toHaveCount(2);

  await page.setInputFiles("#import-input", zipPath);
  await page.click("#conflict-dialog button[value=skip]");
  await expect(page.locator("#banners")).toContainText("추가 0, 덮어쓰기 0, 건너뜀 2");

  const bogus = join(tmpdir(), `uv-bogus-${Date.now()}.zip`);
  writeFileSync(bogus, "not a zip");
  await page.setInputFiles("#import-input", bogus);
  await expect(page.locator("#banners")).toContainText("가져오기 실패: zip 파일을 읽을 수 없습니다");
});

test("잘못된 호스트와 중복 호스트는 대화상자 안에서 거부된다", async ({ ext }) => {
  const page = await openOptions(ext);
  await page.click("#onboarding-add-btn");
  await page.fill("#domain-host", "*.example.com");
  await page.click("#domain-submit-btn");
  await expect(page.locator("#domain-error")).toHaveText("올바른 호스트가 아닙니다 (예: example.com)");
  await expect(page.locator("#domain-dialog")).toBeVisible();

  await page.fill("#domain-host", "Example.COM/path?x=1");
  await page.click("#domain-submit-btn");
  await expect(page.locator("#domain-list .list-item .name")).toHaveText("example.com");

  await page.click("#add-domain-btn");
  await page.fill("#domain-host", "example.com");
  await page.click("#domain-submit-btn");
  await expect(page.locator("#domain-error")).toHaveText("이미 등록된 호스트입니다");
  await page.click("#domain-cancel-btn");
  await expect(page.locator("#domain-list .list-item")).toHaveCount(1);
});

test("팝업은 등록된 도메인에서 스위치 없이 실행 버튼만 보여준다", async ({ ext }) => {
  const opt = await openOptions(ext);
  await addDomainViaUi(opt, "localhost");
  await addScriptViaUi(opt, "title", TITLE_SCRIPT);

  const popup = await ext.context.newPage();
  await popup.addInitScript(() => {
    chrome.tabs.query = (async () => [{ id: 1, url: "http://localhost/", active: true }] as unknown as chrome.tabs.Tab[]) as typeof chrome.tabs.query;
  });
  await popup.goto(ext.popupUrl);
  await expect(popup.locator(".script-row")).toHaveCount(1);
  await expect(popup.locator(".script-row .btn-run")).toHaveText("실행");
  await expect(popup.locator(".switch")).toHaveCount(0);
  await expect(popup.locator("#banner")).toBeHidden();
});

test("팝업은 http(s) 탭이 아니면 사용 불가 안내를 보여준다", async ({ ext }) => {
  const page = await ext.context.newPage();
  await page.goto(ext.popupUrl);
  await expect(page.locator("#content .empty")).toHaveText("여기서는 사용할 수 없습니다");
});
