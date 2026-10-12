import { el, $, clear } from "../lib/dom";
import { normalizeHost } from "../lib/host";
import { patternsFor } from "../lib/patterns";
import {
  readDomains, readScripts, readCode, addDomain, updateDomain, deleteDomain,
  addScript, updateScriptMeta, saveCode, deleteScript, DuplicateHostError,
} from "../lib/storage";
import { WORLD_VALUES, type Domain, type ScriptMeta, type World } from "../lib/types";
import { findSyntaxError } from "../lib/validate";
import { confirmDialog } from "./confirm";
import { createEditor } from "./editor";
import { exportAll, importFile } from "./transfer";
import { renderBanners } from "./banners";

type Stage = "empty" | "domains" | "scripts" | "editor";

interface State {
  domainId: string | null;
  scriptId: string | null;
  dirty: boolean;
}

const state: State = { domainId: null, scriptId: null, dirty: false };

const SAVED_HINT = "저장됨. 팝업 \"실행\"으로 현재 탭에 주입합니다.";
const DISCARD_PROMPT = "저장하지 않은 변경이 있습니다. 버리고 이동할까요?";

// ---- 요소 ----
const layout = $<HTMLElement>("#layout");
const paneScripts = $<HTMLElement>(".pane-scripts");
const paneEditor = $<HTMLElement>(".pane-editor");
const onboarding = $<HTMLElement>("#onboarding");
const domainList = $<HTMLUListElement>("#domain-list");
const domainsHint = $<HTMLElement>("#domains-hint");
const scriptList = $<HTMLUListElement>("#script-list");
const scriptsHeading = $<HTMLElement>("#scripts-heading");
const addScriptBtn = $<HTMLButtonElement>("#add-script-btn");

const scriptName = $<HTMLInputElement>("#script-name");
const worldSelect = $<HTMLSelectElement>("#world");
const saveBtn = $<HTMLButtonElement>("#save-btn");
const statusEl = $<HTMLElement>("#status");

const domainDialog = $<HTMLDialogElement>("#domain-dialog");
const domainForm = $<HTMLFormElement>("#domain-form");
const domainDialogTitle = $<HTMLElement>("#domain-dialog-title");
const domainHost = $<HTMLInputElement>("#domain-host");
const domainSubdomains = $<HTMLInputElement>("#domain-subdomains");
const domainSubdomainsPreview = $<HTMLElement>("#domain-subdomains-preview");
const domainError = $<HTMLElement>("#domain-error");
const domainDeleteBtn = $<HTMLButtonElement>("#domain-delete-btn");
const domainSubmitBtn = $<HTMLButtonElement>("#domain-submit-btn");

const editor = createEditor($("#editor"), { onChange: markDirty, onSave: () => void saveCurrent() });

/** 권한 반납은 최선 노력. 필수 권한이거나 더 넓은 권한에 포함돼 있으면 Chrome이 거부하는데, 그게 데이터 삭제를 막아선 안 된다. */
async function releaseOrigins(origins: string[]): Promise<void> {
  if (origins.length === 0) return;
  try {
    await chrome.permissions.remove({ origins });
  } catch {
    /* 반납 불가. 무시한다. */
  }
}

// ---- 상태줄 / dirty ----
function setStatus(text: string, kind: "" | "warn" | "error" = ""): void {
  statusEl.textContent = text;
  statusEl.className = `status${kind ? ` ${kind}` : ""}`;
}

function markDirty(): void {
  state.dirty = true;
  saveBtn.disabled = false;
  setStatus("변경됨");
}

async function confirmDiscard(): Promise<boolean> {
  return !state.dirty || confirmDialog(DISCARD_PROMPT, "버리기");
}

// ---- 조회 ----
const byHost = (a: Domain, b: Domain) => a.host.localeCompare(b.host);
const byName = (a: ScriptMeta, b: ScriptMeta) => a.name.localeCompare(b.name);

async function currentScript(): Promise<ScriptMeta | null> {
  if (!state.domainId || !state.scriptId) return null;
  return (await readScripts(state.domainId))[state.scriptId] ?? null;
}

// ---- 렌더 ----
function setStage(stage: Stage): void {
  layout.dataset.stage = stage;
  onboarding.hidden = stage !== "empty";
  domainList.hidden = stage === "empty";
  domainsHint.hidden = stage !== "domains";
  paneScripts.hidden = stage === "empty" || stage === "domains";
  paneEditor.hidden = stage !== "editor";
}

function listItem(selected: boolean, onSelect: () => void, ...children: Array<Node | string>): HTMLLIElement {
  const item = el("li", { class: `list-item${selected ? " selected" : ""}`, tabIndex: 0 }, ...children);
  item.addEventListener("click", onSelect);
  item.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect();
    }
  });
  return item;
}

function stopRow(node: HTMLElement): HTMLElement {
  node.addEventListener("click", (e) => e.stopPropagation());
  node.addEventListener("keydown", (e) => e.stopPropagation());
  return node;
}

function renderDomainList(domains: Domain[], counts: number[]): void {
  clear(domainList);
  domains.forEach((domain, i) => {
    const editBtn = stopRow(el("button", { type: "button", class: "btn btn-icon row-btn", title: "도메인 편집", textContent: "편집" }));
    editBtn.addEventListener("click", () => openDomainDialog(domain));
    domainList.append(
      listItem(
        domain.id === state.domainId,
        () => void selectDomain(domain.id),
        el("span", { class: "name", title: domain.host }, domain.includeSubdomains ? `*.${domain.host}` : domain.host),
        el("span", { class: "count", title: "스크립트 수" }, String(counts[i] ?? 0)),
        editBtn,
      ),
    );
  });
}

function renderScriptList(scripts: ScriptMeta[]): void {
  clear(scriptList);
  if (scripts.length === 0) {
    scriptList.append(el("li", { class: "empty" }, "스크립트가 없습니다. 오른쪽 위 \"+ 새 스크립트\"로 만드세요."));
    return;
  }
  for (const script of scripts) {
    const deleteBtn = stopRow(el("button", { type: "button", class: "btn btn-icon danger row-btn", title: "스크립트 삭제", textContent: "삭제" }));
    deleteBtn.addEventListener("click", () => void removeScript(script));
    scriptList.append(
      listItem(
        script.id === state.scriptId,
        () => void selectScript(script.id),
        el("span", { class: "name", title: script.name }, script.name),
        el("span", { class: "tag", title: "실행 world" }, script.world === "MAIN" ? "MAIN" : ""),
        deleteBtn,
      ),
    );
  }
}

/** 저장소를 다시 읽어 목록·단계를 맞춘다. 에디터 본문은 건드리지 않는다. */
async function refresh(): Promise<void> {
  const domainMap = await readDomains();
  const domains = Object.values(domainMap).sort(byHost);
  if (state.domainId && !domainMap[state.domainId]) {
    state.domainId = null;
    state.scriptId = null;
    state.dirty = false;
  }
  const counts = await Promise.all(domains.map(async (d) => Object.keys(await readScripts(d.id)).length));
  const scripts = state.domainId ? Object.values(await readScripts(state.domainId)).sort(byName) : [];
  if (state.scriptId && !scripts.some((s) => s.id === state.scriptId)) {
    state.scriptId = null;
    state.dirty = false;
  }

  renderDomainList(domains, counts);
  renderScriptList(scripts);
  const domain = state.domainId ? domainMap[state.domainId] : undefined;
  scriptsHeading.textContent = domain ? (domain.includeSubdomains ? `*.${domain.host}` : domain.host) : "스크립트";

  const stage: Stage = domains.length === 0 ? "empty" : !state.domainId ? "domains" : !state.scriptId ? "scripts" : "editor";
  setStage(stage);
}

// ---- 선택 ----
async function selectDomain(id: string): Promise<void> {
  if (id === state.domainId) return;
  if (!(await confirmDiscard())) return;
  state.domainId = id;
  state.scriptId = null;
  state.dirty = false;
  await refresh();
}

async function selectScript(id: string): Promise<void> {
  if (id === state.scriptId) return;
  if (!(await confirmDiscard())) return;
  await openScript(id);
}

async function openScript(id: string): Promise<void> {
  state.scriptId = id;
  state.dirty = false;
  const script = await currentScript();
  if (!script) {
    state.scriptId = null;
    await refresh();
    return;
  }
  editor.setValue(await readCode(script.id));
  editor.setEnabled(true);
  scriptName.value = script.name;
  worldSelect.value = script.world;
  saveBtn.disabled = true;
  setStatus("");
  await refresh();
}

async function saveCurrent(): Promise<void> {
  const script = await currentScript();
  if (!script) return;
  const name = scriptName.value.trim() || script.name;
  const world = WORLD_VALUES.includes(worldSelect.value as World) ? (worldSelect.value as World) : script.world;
  const code = editor.getValue();
  try {
    await updateScriptMeta(script.domainId, script.id, { name, world });
    await saveCode(script.domainId, script.id, code);
  } catch (err) {
    setStatus(`저장 실패: ${err instanceof Error ? err.message : String(err)}`, "error");
    return;
  }
  state.dirty = false;
  saveBtn.disabled = true;
  const syntax = findSyntaxError(code);
  if (syntax) setStatus(`저장됨. 문법 오류: ${syntax.line}번째 줄 근처`, "error");
  else setStatus(SAVED_HINT);
  await refresh();
}

async function removeScript(script: ScriptMeta): Promise<void> {
  if (!(await confirmDialog(`"${script.name}" 스크립트를 삭제할까요?`, "삭제"))) return;
  await deleteScript(script.domainId, script.id);
  if (script.id === state.scriptId) {
    state.scriptId = null;
    state.dirty = false;
  }
  await refresh();
}

addScriptBtn.addEventListener("click", async () => {
  if (!state.domainId) return;
  if (!(await confirmDiscard())) return;
  const existing = Object.keys(await readScripts(state.domainId)).length;
  const script = await addScript(state.domainId, `script-${existing + 1}`);
  await openScript(script.id);
  scriptName.focus();
  scriptName.select();
});

saveBtn.addEventListener("click", () => void saveCurrent());
scriptName.addEventListener("input", markDirty);
worldSelect.addEventListener("change", markDirty);

window.addEventListener("beforeunload", (e) => {
  if (state.dirty) e.preventDefault();
});

// ---- 도메인 대화상자 (추가 / 편집 / 삭제) ----
let editingDomain: Domain | null = null;

function showDomainError(message: string | null): void {
  domainError.textContent = message ?? "";
  domainError.hidden = message === null;
}

function updateSubdomainPreview(): void {
  const result = normalizeHost(domainHost.value);
  domainSubdomainsPreview.textContent = `*.${result.ok ? result.host : "example.com"}`;
}

function openDomainDialog(domain: Domain | null, prefill = ""): void {
  editingDomain = domain;
  domainDialogTitle.textContent = domain ? "도메인 편집" : "도메인 추가";
  domainSubmitBtn.textContent = domain ? "저장" : "추가";
  domainDeleteBtn.hidden = domain === null;
  domainHost.value = domain?.host ?? prefill;
  domainSubdomains.checked = domain?.includeSubdomains ?? false;
  updateSubdomainPreview();
  showDomainError(null);
  domainDialog.returnValue = "";
  domainDialog.showModal();
  domainHost.focus();
  domainHost.select();
}

domainHost.addEventListener("input", updateSubdomainPreview);
domainSubdomains.addEventListener("change", updateSubdomainPreview);
$("#add-domain-btn").addEventListener("click", () => openDomainDialog(null));
$("#onboarding-add-btn").addEventListener("click", () => openDomainDialog(null));
$("#domain-cancel-btn").addEventListener("click", () => domainDialog.close());

domainForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const result = normalizeHost(domainHost.value);
  if (!result.ok) {
    showDomainError(result.error === "empty" ? "호스트를 입력하세요" : "올바른 호스트가 아닙니다 (예: example.com)");
    return;
  }
  const includeSubdomains = domainSubdomains.checked;
  const domains = await readDomains();
  if (Object.values(domains).some((d) => d.host === result.host && d.id !== editingDomain?.id)) {
    showDomainError("이미 등록된 호스트입니다");
    return;
  }
  const next = { host: result.host, includeSubdomains };
  try {
    // permissions.request는 사용자 제스처(transient activation) 안에서만 동작한다.
    const granted = await chrome.permissions.request({ origins: patternsFor(next) });
    if (!granted) {
      showDomainError("사이트 접근 권한이 필요합니다");
      return;
    }
    if (editingDomain) {
      const before = patternsFor(editingDomain);
      await updateDomain(editingDomain.id, next);
      await releaseOrigins(before.filter((p) => !patternsFor(next).includes(p)));
    } else {
      const created = await addDomain(next);
      state.domainId = created.id;
      state.scriptId = null;
      state.dirty = false;
    }
  } catch (err) {
    showDomainError(err instanceof DuplicateHostError ? "이미 등록된 호스트입니다" : `실패: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  domainDialog.close();
  await refresh();
});

domainDeleteBtn.addEventListener("click", async () => {
  const domain = editingDomain;
  if (!domain) return;
  const count = Object.keys(await readScripts(domain.id)).length;
  if (!(await confirmDialog(`${domain.host} 도메인과 스크립트 ${count}개를 삭제할까요?`, "삭제"))) return;
  await releaseOrigins(patternsFor(domain));
  await deleteDomain(domain.id);
  if (domain.id === state.domainId) {
    state.domainId = null;
    state.scriptId = null;
    state.dirty = false;
  }
  domainDialog.close();
  await refresh();
});

// ---- 가져오기 / 내보내기 ----
$<HTMLButtonElement>("#export-btn").addEventListener("click", () => void exportAll());

const importInput = $<HTMLInputElement>("#import-input");
importInput.addEventListener("change", async () => {
  const file = importInput.files?.[0];
  importInput.value = "";
  if (!file) return;
  const message = await importFile(file);
  await refresh();
  if (message) setStatus(message, message.startsWith("가져오기 실패") || message.startsWith("가져오기 취소") ? "error" : "");
  if (message && paneEditor.hidden) {
    // 에디터가 닫혀 있으면 상태줄이 안 보인다. 배너 영역에 잠깐 띄운다.
    const banner = el("div", { class: `banner ${message.startsWith("가져오기 완료") ? "banner-warn" : "banner-error"}` }, message);
    $("#banners").append(banner);
    setTimeout(() => banner.remove(), 6000);
  }
});

// ---- 부트스트랩 ----
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  // refresh는 목록·단계만 다시 그리고 에디터 본문은 건드리지 않으므로 편집 중에도 안전하다.
  if ("domains" in changes || Object.keys(changes).some((k) => k.startsWith("scripts:"))) void refresh();
});

renderBanners();
void refresh();
const add = new URLSearchParams(location.search).get("add");
if (add) openDomainDialog(null, add);
