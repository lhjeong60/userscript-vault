export type HostResult = { ok: true; host: string } | { ok: false; error: "empty" | "invalid" };

// match pattern(`*://host/*`)과 permissions.request가 받아들이는 형태만 통과시킨다.
const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

function isValidHostname(host: string): boolean {
  if (host === "localhost") return true;
  if (host.startsWith("[") && host.endsWith("]")) return true; // IPv6, URL 파서가 이미 검증
  if (IPV4.test(host)) return true;
  const labels = host.split(".");
  return labels.length >= 2 && labels.every((l) => LABEL.test(l));
}

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
  hostname = hostname.replace(/\.$/, ""); // 끝 점(FQDN 표기)은 제거
  if (!hostname || !isValidHostname(hostname)) return { ok: false, error: "invalid" };
  return { ok: true, host: hostname };
}
