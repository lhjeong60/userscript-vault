import { describe, it, expect } from "vitest";
import { unzipSync, strFromU8, zipSync, strToU8 } from "fflate";
import { safeFileName, buildExport, parseImport, planImport } from "../src/lib/archive";
import type { StorageSnapshot, Domain, ScriptMeta, ExportManifest } from "../src/lib/types";
import { scriptsKey, codeKey } from "../src/lib/storage";

const domain = (id: string, host: string, extra: Partial<Domain> = {}): Domain => ({
  id, host, includeSubdomains: false, createdAt: 0, ...extra,
});
const script = (id: string, domainId: string, name: string, extra: Partial<ScriptMeta> = {}): ScriptMeta => ({
  id, domainId, name, world: "USER_SCRIPT", updatedAt: 0, ...extra,
});
const snap = (parts: Partial<StorageSnapshot>): StorageSnapshot => ({ domains: {}, scripts: {}, code: {}, ...parts });
const parsedScript = (name: string, code: string, world: "USER_SCRIPT" | "MAIN" = "USER_SCRIPT") => ({ name, world, code });

describe("safeFileName", () => {
  it("replaces forbidden characters and trims", () => {
    expect(safeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe("a_b_c_d_e_f_g_h_i_j");
    expect(safeFileName("  .hidden. ")).toBe("hidden");
    expect(safeFileName("tab\there")).toBe("tab_here");
  });
  it("falls back to 'script' when nothing is left", () => {
    expect(safeFileName("???")).toBe("___");
    expect(safeFileName("...")).toBe("script");
    expect(safeFileName("")).toBe("script");
  });
});

describe("buildExport", () => {
  it("writes export.json and one file per script, deduplicating names", () => {
    const s = snap({
      domains: { d1: domain("d1", "a.com", { includeSubdomains: true }) },
      scripts: { d1: { s1: script("s1", "d1", "x/y", { world: "MAIN" }), s2: script("s2", "d1", "x_y"), s3: script("s3", "d1", "...") } },
      code: { s1: "one", s2: "two", s3: "three" },
    });
    const files = unzipSync(buildExport(s, new Date("2026-10-07T00:00:00Z")));
    const manifest = JSON.parse(strFromU8(files["export.json"]!)) as ExportManifest;
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.exportedAt).toBe("2026-10-07T00:00:00.000Z");
    expect(manifest.domains).toEqual([
      {
        host: "a.com", includeSubdomains: true,
        scripts: [
          { name: "x/y", file: "a.com/x_y.js", world: "MAIN" },
          { name: "x_y", file: "a.com/x_y-2.js", world: "USER_SCRIPT" },
          { name: "...", file: "a.com/script.js", world: "USER_SCRIPT" },
        ],
      },
    ]);
    expect(strFromU8(files["a.com/x_y.js"]!)).toBe("one");
    expect(strFromU8(files["a.com/x_y-2.js"]!)).toBe("two");
    expect(strFromU8(files["a.com/script.js"]!)).toBe("three");
  });
});

describe("parseImport", () => {
  const zipOf = (files: Record<string, string>) =>
    zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));

  it("rejects garbage, missing export.json, bad json, wrong schema", () => {
    expect(parseImport(new Uint8Array([1, 2, 3]))).toMatchObject({ ok: false });
    expect(parseImport(zipOf({ "a.com/x.js": "" }))).toEqual({ ok: false, error: "export.json이 없습니다" });
    expect(parseImport(zipOf({ "export.json": "{" }))).toMatchObject({ ok: false });
    expect(parseImport(zipOf({ "export.json": JSON.stringify({ schemaVersion: 99, domains: [] }) }))).toMatchObject({ ok: false });
  });

  it("treats prototype property names as missing files instead of throwing", () => {
    const manifest = { schemaVersion: 1, exportedAt: "x", domains: [{ host: "a.com", scripts: [
      { name: "evil", file: "constructor" }, { name: "evil2", file: "__proto__" }, { name: "ok", file: "a.com/ok.js" },
    ] }] };
    const result = parseImport(zipOf({ "export.json": JSON.stringify(manifest), "a.com/ok.js": "1" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.domains[0]?.scripts.map((s) => s.name)).toEqual(["ok"]);
    expect(result.value.skipped).toHaveLength(2);
  });

  it("parses domains and scripts, skipping missing files and fixing a bad world", () => {
    const manifest = {
      schemaVersion: 1, exportedAt: "x",
      domains: [
        {
          host: "A.com", includeSubdomains: true,
          scripts: [
            { name: "ok", file: "A.com/ok.js", world: "MAIN" },
            { name: "gone", file: "A.com/gone.js", world: "USER_SCRIPT" },
            { name: "weird", file: "A.com/weird.js", world: "MARS" },
          ],
        },
        { host: "not a host", scripts: [] },
        { nohost: true },
      ],
    };
    const result = parseImport(zipOf({ "export.json": JSON.stringify(manifest), "A.com/ok.js": "1", "A.com/weird.js": "2" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.domains).toEqual([
      {
        host: "a.com", includeSubdomains: true,
        scripts: [
          { name: "ok", world: "MAIN", code: "1" },
          { name: "weird", world: "USER_SCRIPT", code: "2" },
        ],
      },
    ]);
    expect(result.value.skipped).toHaveLength(3);
  });
});

describe("planImport", () => {
  let n = 0;
  const newId = () => `id${++n}`;

  it("creates new domain, requests origins, adds scripts", () => {
    n = 0;
    const plan = planImport(
      { domains: [{ host: "a.com", includeSubdomains: true, scripts: [parsedScript("s", "c")] }], skipped: ["x"] },
      snap({}), "skip", 42, newId,
    );
    expect(plan.newOrigins).toEqual(["*://a.com/*", "*://*.a.com/*"]);
    expect(plan.summary).toEqual({ added: 1, overwritten: 0, skipped: 1 });
    expect(plan.set.domains).toEqual({ id1: { id: "id1", host: "a.com", includeSubdomains: true, createdAt: 42 } });
    expect(plan.set[scriptsKey("id1")]).toEqual({ id2: { id: "id2", domainId: "id1", name: "s", world: "USER_SCRIPT", updatedAt: 42 } });
    expect(plan.set[codeKey("id2")]).toBe("c");
  });

  it("merges into existing domain keeping its flags, honoring skip policy", () => {
    n = 0;
    const existing = snap({
      domains: { d1: domain("d1", "a.com", { includeSubdomains: false }) },
      scripts: { d1: { s1: script("s1", "d1", "dup") } },
      code: { s1: "old" },
    });
    const parsed = { domains: [{ host: "a.com", includeSubdomains: true, scripts: [
      parsedScript("dup", "new", "MAIN"),
      parsedScript("fresh", "f"),
    ] }], skipped: [] };
    const plan = planImport(parsed, existing, "skip", 7, newId);
    expect(plan.newOrigins).toEqual([]);
    expect(plan.summary).toEqual({ added: 1, overwritten: 0, skipped: 1 });
    expect((plan.set.domains as Record<string, Domain>).d1).toEqual(existing.domains.d1);
    const scripts = plan.set[scriptsKey("d1")] as Record<string, ScriptMeta>;
    expect(scripts.s1).toEqual(existing.scripts.d1!.s1);
    expect(Object.values(scripts).map((s) => s.name).sort()).toEqual(["dup", "fresh"]);
    expect(codeKey("s1") in plan.set).toBe(false);
  });

  it("keeps duplicate names inside one zip as separate scripts (round trip)", () => {
    n = 0;
    const parsed = { domains: [{ host: "a.com", includeSubdomains: false, scripts: [parsedScript("foo", "one"), parsedScript("foo", "two")] }], skipped: [] };
    for (const policy of ["skip", "overwrite"] as const) {
      n = 0;
      const plan = planImport(parsed, snap({}), policy, 1, newId);
      expect(plan.summary).toEqual({ added: 2, overwritten: 0, skipped: 0 });
      const scripts = plan.set[scriptsKey("id1")] as Record<string, ScriptMeta>;
      expect(Object.keys(scripts)).toHaveLength(2);
      expect(plan.set[codeKey("id2")]).toBe("one");
      expect(plan.set[codeKey("id3")]).toBe("two");
    }
  });

  it("matches each existing script at most once when overwriting", () => {
    n = 0;
    const existing = snap({
      domains: { d1: domain("d1", "a.com") },
      scripts: { d1: { s1: script("s1", "d1", "foo") } },
      code: { s1: "old" },
    });
    const plan = planImport({ domains: [{ host: "a.com", includeSubdomains: false, scripts: [parsedScript("foo", "one"), parsedScript("foo", "two")] }], skipped: [] }, existing, "overwrite", 1, newId);
    expect(plan.summary).toEqual({ added: 1, overwritten: 1, skipped: 0 });
    const scripts = plan.set[scriptsKey("d1")] as Record<string, ScriptMeta>;
    expect(Object.keys(scripts).sort()).toEqual(["id1", "s1"]);
    expect(plan.set[codeKey("s1")]).toBe("one");
    expect(plan.set[codeKey("id1")]).toBe("two");
  });

  it("accumulates scripts when the same host appears twice in export.json", () => {
    n = 0;
    const one = { host: "a.com", includeSubdomains: false, scripts: [parsedScript("x", "1")] };
    const two = { host: "a.com", includeSubdomains: false, scripts: [parsedScript("y", "2")] };
    const plan = planImport({ domains: [one, two], skipped: [] }, snap({}), "skip", 1, newId);
    expect(plan.summary.added).toBe(2);
    expect(Object.keys(plan.set.domains as Record<string, Domain>)).toHaveLength(1);
    const scripts = plan.set[scriptsKey("id1")] as Record<string, ScriptMeta>;
    expect(Object.values(scripts).map((s) => s.name).sort()).toEqual(["x", "y"]);
  });

  it("overwrites existing script keeping its id", () => {
    n = 0;
    const existing = snap({
      domains: { d1: domain("d1", "a.com") },
      scripts: { d1: { s1: script("s1", "d1", "dup") } },
      code: { s1: "old" },
    });
    const parsed = { domains: [{ host: "a.com", includeSubdomains: false, scripts: [parsedScript("dup", "new", "MAIN")] }], skipped: [] };
    const plan = planImport(parsed, existing, "overwrite", 7, newId);
    expect(plan.summary).toEqual({ added: 0, overwritten: 1, skipped: 0 });
    expect((plan.set[scriptsKey("d1")] as Record<string, ScriptMeta>).s1).toEqual({
      id: "s1", domainId: "d1", name: "dup", world: "MAIN", updatedAt: 7,
    });
    expect(plan.set[codeKey("s1")]).toBe("new");
  });
});
