import { el, $, clear } from "../lib/dom";

export function renderBanners(): void {
  const container = $<HTMLElement>("#banners");
  clear(container);

  if (typeof chrome.userScripts === "undefined" || typeof chrome.userScripts.execute !== "function") {
    container.append(
      el(
        "div",
        { class: "banner banner-warn" },
        "사용자 스크립트가 꺼져 있어 \"실행\"이 동작하지 않습니다. ",
        el("code", {}, "chrome://extensions"),
        " → userscript-vault 세부정보 → \"사용자 스크립트 허용\"을 켜세요.",
      ),
    );
  }
}
