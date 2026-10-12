import { el, $, clear } from "../lib/dom";
import { hostMatches, patternsFor } from "../lib/patterns";
import { readDomains, readScripts, readCode } from "../lib/storage";
import type { Domain, ScriptMeta } from "../lib/types";

const hostEl = $<HTMLSpanElement>("#host");
const banner = $<HTMLDivElement>("#banner");
const content = $<HTMLElement>("#content");
const notice = $<HTMLDivElement>("#notice");

interface CurrentTab { id: number; host: string }

async function currentTab(): Promise<CurrentTab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || tab.id === undefined) return null;
  try {
    const url = new URL(tab.url);
    return url.protocol === "http:" || url.protocol === "https:" ? { id: tab.id, host: url.hostname } : null;
  } catch {
    return null;
  }
}

function optionsUrl(addHost?: string): string {
  const base = chrome.runtime.getURL("src/options/options.html");
  return addHost ? `${base}?add=${encodeURIComponent(addHost)}` : base;
}

function canExecute(): boolean {
  return typeof chrome.userScripts !== "undefined" && typeof chrome.userScripts.execute === "function";
}

function showNotice(text: string, isError = false): void {
  notice.textContent = text;
  notice.className = `notice${isError ? " error" : ""}`;
  notice.hidden = false;
  setTimeout(() => (notice.hidden = true), 2500);
}

/** 현재 탭에 한 번 주입한다. 유일한 실행 경로다. */
async function runOnce(tab: CurrentTab, domain: Domain, script: ScriptMeta): Promise<void> {
  // 가드 1: 현재 탭 호스트가 이 스크립트의 도메인과 맞아야 한다.
  // 팝업은 매칭 도메인만 보여주지만, 버튼을 만든 뒤 탭이 바뀌었을 수도 있으니 실행 직전에 다시 확인한다.
  if (!hostMatches(domain, tab.host)) {
    showNotice(`현재 탭(${tab.host})은 이 스크립트의 도메인이 아닙니다`, true);
    return;
  }
  // 가드 2: 이 도메인에 대한 사이트 접근 권한이 있어야 execute가 성공한다.
  const hasPermission = await chrome.permissions.contains({ origins: patternsFor(domain) });
  if (!hasPermission) {
    showNotice(`${domain.host} 사이트 접근 권한이 없습니다. 관리 페이지에서 도메인을 다시 추가하세요`, true);
    return;
  }
  const code = await readCode(script.id);
  if (!code.trim()) {
    showNotice("스크립트 본문이 비어 있습니다", true);
    return;
  }
  try {
    const results = await chrome.userScripts.execute({
      js: [{ code }],
      target: { tabId: tab.id },
      world: script.world as `${chrome.userScripts.ExecutionWorld}` as chrome.userScripts.ExecutionWorld,
      injectImmediately: true,
    });
    const failed = results.find((r) => r.error);
    if (failed) showNotice(`실행 오류: ${failed.error}`, true);
    else showNotice(`"${script.name}" 실행함`);
  } catch (e) {
    showNotice(`실행 실패: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}

async function renderDomain(tab: CurrentTab, domain: Domain): Promise<HTMLElement> {
  const scripts = Object.values(await readScripts(domain.id)).sort((a, b) => a.name.localeCompare(b.name));
  const box = el("section", { class: "domain" });
  box.append(
    el(
      "div",
      { class: "row domain-row" },
      el("span", { class: "name" }, domain.includeSubdomains ? `*.${domain.host}` : domain.host),
    ),
  );
  if (scripts.length === 0) box.append(el("div", { class: "empty" }, "스크립트 없음"));
  for (const script of scripts) {
    const runBtn = el("button", { type: "button", class: "btn btn-run", textContent: "실행", title: "지금 이 탭에서 한 번 실행" });
    runBtn.disabled = !canExecute();
    runBtn.addEventListener("click", () => void runOnce(tab, domain, script));
    box.append(
      el(
        "div",
        { class: "row script-row" },
        el("span", { class: "name", title: script.name }, script.name),
        script.world === "MAIN" ? el("span", { class: "tag" }, "MAIN") : "",
        runBtn,
      ),
    );
  }
  return box;
}

async function render(): Promise<void> {
  banner.hidden = canExecute();
  banner.textContent = "사용자 스크립트가 꺼져 있습니다. 관리 페이지의 안내를 따라 켜세요.";

  const tab = await currentTab();
  clear(content);
  if (!tab) {
    hostEl.textContent = "—";
    content.append(el("div", { class: "empty" }, "여기서는 사용할 수 없습니다"));
    return;
  }
  hostEl.textContent = tab.host;
  hostEl.title = tab.host;

  const matched = Object.values(await readDomains())
    .filter((d) => hostMatches(d, tab.host))
    .sort((a, b) => b.host.length - a.host.length);

  if (matched.length === 0) {
    const add = el("button", { class: "btn btn-primary", type: "button" }, `${tab.host} 추가`);
    add.addEventListener("click", () => void chrome.tabs.create({ url: optionsUrl(tab.host) }));
    content.append(el("div", { class: "empty" }, "이 사이트에 등록된 도메인이 없습니다"), el("div", { class: "actions" }, add));
    return;
  }
  for (const domain of matched) content.append(await renderDomain(tab, domain));
  content.append(el("p", { class: "legend" }, "\"실행\"을 누르면 현재 탭에 한 번 주입합니다."));
}

$("#open-options").addEventListener("click", () => void chrome.runtime.openOptionsPage());
void render();
