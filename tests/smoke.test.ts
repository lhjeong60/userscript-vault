import { describe, it, expect } from "vitest";
import manifest from "../manifest.json";

describe("manifest", () => {
  it("has no static host_permissions", () => {
    expect("host_permissions" in manifest).toBe(false);
    expect(manifest.optional_host_permissions).toEqual(["<all_urls>"]);
  });
  it("declares required permissions", () => {
    expect(manifest.permissions).toEqual(
      expect.arrayContaining(["userScripts", "storage", "unlimitedStorage", "activeTab"]),
    );
  });
});
