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
