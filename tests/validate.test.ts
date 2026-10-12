import { describe, it, expect } from "vitest";
import { findSyntaxError } from "../src/lib/validate";

describe("findSyntaxError", () => {
  it("returns null for valid code", () => {
    expect(findSyntaxError("const x = 1;\nconsole.log(x);")).toBeNull();
    expect(findSyntaxError("")).toBeNull();
    expect(findSyntaxError("async function f() { await g?.(); }\nclass A { #p = 1 }")).toBeNull();
  });

  it("reports the line of the first error", () => {
    expect(findSyntaxError("const ok = 1;\nconst x = ;")).toEqual({ line: 2 });
    expect(findSyntaxError("function f( {")).toEqual({ line: 1 });
  });
});
