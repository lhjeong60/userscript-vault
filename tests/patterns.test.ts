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
