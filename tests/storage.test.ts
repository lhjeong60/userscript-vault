import { describe, it, expect, beforeEach } from "vitest";
import { installFakeChrome } from "./fake-chrome";
import {
  addDomain, updateDomain, deleteDomain, addScript, updateScriptMeta, saveCode, deleteScript,
  readAll, readDomains, readScripts, readCode, applyBatch, DuplicateHostError,
  scriptsKey, codeKey,
} from "../src/lib/storage";

describe("storage", () => {
  let fake: ReturnType<typeof installFakeChrome>;
  beforeEach(() => {
    fake = installFakeChrome();
  });

  it("addDomain creates domain with empty scripts bucket", async () => {
    const d = await addDomain({ host: "github.com", includeSubdomains: false }, 1000);
    expect(d).toMatchObject({ host: "github.com", includeSubdomains: false, createdAt: 1000 });
    expect(d.id).toMatch(/[0-9a-f-]{36}/);
    const dump = fake.dump();
    expect(dump.domains).toEqual({ [d.id]: d });
    expect(dump[scriptsKey(d.id)]).toEqual({});
  });

  it("addDomain rejects duplicate host", async () => {
    await addDomain({ host: "github.com", includeSubdomains: false });
    await expect(addDomain({ host: "github.com", includeSubdomains: true })).rejects.toBeInstanceOf(DuplicateHostError);
  });

  it("updateDomain patches and returns new object", async () => {
    const d = await addDomain({ host: "a.com", includeSubdomains: false });
    const next = await updateDomain(d.id, { includeSubdomains: true });
    expect(next).toEqual({ ...d, includeSubdomains: true });
    expect((await readDomains())[d.id]).toEqual(next);
  });

  it("updateDomain can rename host but rejects a host already in use", async () => {
    const a = await addDomain({ host: "a.com", includeSubdomains: false });
    await addDomain({ host: "b.com", includeSubdomains: false });
    const renamed = await updateDomain(a.id, { host: "c.com" });
    expect(renamed.host).toBe("c.com");
    await expect(updateDomain(a.id, { host: "b.com" })).rejects.toBeInstanceOf(DuplicateHostError);
    expect((await readDomains())[a.id]?.host).toBe("c.com");
  });

  it("addScript creates meta with defaults and empty code", async () => {
    const d = await addDomain({ host: "a.com", includeSubdomains: false });
    const s = await addScript(d.id, "dark", 5);
    expect(s).toEqual({ id: s.id, domainId: d.id, name: "dark", world: "USER_SCRIPT", updatedAt: 5 });
    expect(await readScripts(d.id)).toEqual({ [s.id]: s });
    expect(await readCode(s.id)).toBe("");
  });

  it("saveCode stores code and bumps updatedAt", async () => {
    const d = await addDomain({ host: "a.com", includeSubdomains: false });
    const s = await addScript(d.id, "dark", 5);
    await saveCode(d.id, s.id, "console.log(1)", 9);
    expect(await readCode(s.id)).toBe("console.log(1)");
    expect((await readScripts(d.id))[s.id]?.updatedAt).toBe(9);
  });

  it("updateScriptMeta patches fields", async () => {
    const d = await addDomain({ host: "a.com", includeSubdomains: false });
    const s = await addScript(d.id, "dark");
    const next = await updateScriptMeta(d.id, s.id, { name: "light", world: "MAIN" }, 7);
    expect(next).toEqual({ ...s, name: "light", world: "MAIN", updatedAt: 7 });
  });

  it("deleteScript removes meta and code", async () => {
    const d = await addDomain({ host: "a.com", includeSubdomains: false });
    const s = await addScript(d.id, "dark");
    await saveCode(d.id, s.id, "x", 1);
    await deleteScript(d.id, s.id);
    expect(await readScripts(d.id)).toEqual({});
    expect(codeKey(s.id) in fake.dump()).toBe(false);
  });

  it("deleteDomain cascades to scripts and code keys", async () => {
    const d = await addDomain({ host: "a.com", includeSubdomains: false });
    const keep = await addDomain({ host: "b.com", includeSubdomains: false });
    const s1 = await addScript(d.id, "one");
    const s2 = await addScript(d.id, "two");
    await deleteDomain(d.id);
    const dump = fake.dump();
    expect(Object.keys(dump).sort()).toEqual(["domains", scriptsKey(keep.id)].sort());
    expect(dump.domains).toEqual({ [keep.id]: keep });
    expect(codeKey(s1.id) in dump).toBe(false);
    expect(codeKey(s2.id) in dump).toBe(false);
  });

  it("readAll assembles snapshot", async () => {
    const d = await addDomain({ host: "a.com", includeSubdomains: false });
    const s = await addScript(d.id, "one");
    await saveCode(d.id, s.id, "code", 1);
    const snap = await readAll();
    expect(snap.domains[d.id]?.host).toBe("a.com");
    expect(snap.scripts[d.id]?.[s.id]?.name).toBe("one");
    expect(snap.code[s.id]).toBe("code");
  });

  it("applyBatch writes all keys at once", async () => {
    await applyBatch({ domains: { x: 1 }, "code:y": "z" });
    expect(fake.dump()).toEqual({ domains: { x: 1 }, "code:y": "z" });
  });
});
