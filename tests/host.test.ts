import { describe, it, expect } from "vitest";
import { normalizeHost } from "../src/lib/host";

describe("normalizeHost", () => {
  it.each([
    ["github.com", "github.com"],
    ["  GitHub.COM  ", "github.com"],
    ["https://github.com/foo/bar?x=1", "github.com"],
    ["http://Example.com:8080/path", "example.com"],
    ["localhost:3000", "localhost"],
    ["localhost", "localhost"],
    ["127.0.0.1", "127.0.0.1"],
    ["sub.domain.co.kr", "sub.domain.co.kr"],
    ["example.com.", "example.com"],
    ["[::1]", "[::1]"],
  ])("normalizes %j → %j", (input, host) => {
    expect(normalizeHost(input)).toEqual({ ok: true, host });
  });

  it("rejects empty input", () => {
    expect(normalizeHost("")).toEqual({ ok: false, error: "empty" });
    expect(normalizeHost("   ")).toEqual({ ok: false, error: "empty" });
  });

  it.each(["git hub.com", "nodots", "https://", "://x", "a b", "*.example.com", "ex*ample.com", "exa_mple.com", "-bad.com", "bad-.com"])("rejects %j", (input) => {
    expect(normalizeHost(input)).toEqual({ ok: false, error: "invalid" });
  });
});
