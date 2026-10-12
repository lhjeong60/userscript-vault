import { $ } from "../lib/dom";

export function confirmDialog(text: string, okLabel = "확인"): Promise<boolean> {
  const dialog = $<HTMLDialogElement>("#confirm-dialog");
  $("#confirm-text").textContent = text;
  $("#confirm-ok").textContent = okLabel;
  return new Promise((resolve) => {
    dialog.returnValue = ""; // Esc는 returnValue를 바꾸지 않는다. 이전 "ok"가 남으면 취소가 확인으로 처리된다.
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok"), { once: true });
    dialog.showModal();
  });
}
