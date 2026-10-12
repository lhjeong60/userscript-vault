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
  // TS 5.9: fflate의 Uint8Array<ArrayBufferLike>는 BlobPart가 아니다. 복사해서 ArrayBuffer 기반으로 만든다.
  const blob = new Blob([new Uint8Array(bytes)], { type: "application/zip" });
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
    dialog.returnValue = ""; // Esc 취소가 이전 선택으로 처리되지 않게 초기화
    dialog.addEventListener(
      "close",
      () => resolve(dialog.returnValue === "overwrite" || dialog.returnValue === "skip" ? dialog.returnValue : null),
      { once: true },
    );
    dialog.showModal();
  });
}

export async function importFile(file: File): Promise<string> {
  try {
    return await importFileUnsafe(file);
  } catch (e) {
    return `가져오기 실패: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function importFileUnsafe(file: File): Promise<string> {
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
