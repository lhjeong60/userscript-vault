import type { Domain, ScriptMeta, StorageSnapshot } from "./types";

export const scriptsKey = (domainId: string): string => `scripts:${domainId}`;
export const codeKey = (scriptId: string): string => `code:${scriptId}`;

const SCRIPTS_PREFIX = "scripts:";
const CODE_PREFIX = "code:";

const local = () => chrome.storage.local;

export class DuplicateHostError extends Error {
  constructor(host: string) {
    super(`이미 등록된 호스트: ${host}`);
    this.name = "DuplicateHostError";
  }
}

export async function readDomains(): Promise<Record<string, Domain>> {
  const r = await local().get("domains");
  return (r.domains as Record<string, Domain> | undefined) ?? {};
}

export async function readScripts(domainId: string): Promise<Record<string, ScriptMeta>> {
  const key = scriptsKey(domainId);
  const r = await local().get(key);
  return (r[key] as Record<string, ScriptMeta> | undefined) ?? {};
}

export async function readCode(scriptId: string): Promise<string> {
  const key = codeKey(scriptId);
  const r = await local().get(key);
  return (r[key] as string | undefined) ?? "";
}

export async function readAll(): Promise<StorageSnapshot> {
  const all = await local().get(null);
  const domains: Record<string, Domain> = {};
  const scripts: Record<string, Record<string, ScriptMeta>> = {};
  const code: Record<string, string> = {};
  for (const [key, value] of Object.entries(all)) {
    if (key === "domains") Object.assign(domains, value as Record<string, Domain>);
    else if (key.startsWith(SCRIPTS_PREFIX)) scripts[key.slice(SCRIPTS_PREFIX.length)] = value as Record<string, ScriptMeta>;
    else if (key.startsWith(CODE_PREFIX)) code[key.slice(CODE_PREFIX.length)] = value as string;
  }
  return { domains, scripts, code };
}

export async function addDomain(
  input: { host: string; includeSubdomains: boolean },
  now: number = Date.now(),
): Promise<Domain> {
  const domains = await readDomains();
  if (Object.values(domains).some((d) => d.host === input.host)) throw new DuplicateHostError(input.host);
  const domain: Domain = {
    id: crypto.randomUUID(),
    host: input.host,
    includeSubdomains: input.includeSubdomains,
    createdAt: now,
  };
  await local().set({ domains: { ...domains, [domain.id]: domain }, [scriptsKey(domain.id)]: {} });
  return domain;
}

export async function updateDomain(
  id: string,
  patch: Partial<Pick<Domain, "includeSubdomains" | "host">>,
): Promise<Domain> {
  const domains = await readDomains();
  const current = domains[id];
  if (!current) throw new Error(`도메인을 찾을 수 없음: ${id}`);
  if (patch.host !== undefined && patch.host !== current.host) {
    if (Object.values(domains).some((d) => d.id !== id && d.host === patch.host)) throw new DuplicateHostError(patch.host);
  }
  const next: Domain = { ...current, ...patch };
  await local().set({ domains: { ...domains, [id]: next } });
  return next;
}

export async function deleteDomain(id: string): Promise<void> {
  const domains = await readDomains();
  if (!domains[id]) return;
  const scripts = await readScripts(id);
  const { [id]: _removed, ...rest } = domains;
  // 자식 먼저 지운다. 중간에 끊겨도 고아 code 키가 아니라 빈 도메인이 남는 쪽이 복구하기 쉽다.
  await local().remove([scriptsKey(id), ...Object.keys(scripts).map(codeKey)]);
  await local().set({ domains: rest });
}

export async function addScript(domainId: string, name: string, now: number = Date.now()): Promise<ScriptMeta> {
  const scripts = await readScripts(domainId);
  const meta: ScriptMeta = {
    id: crypto.randomUUID(),
    domainId,
    name,
    world: "USER_SCRIPT",
    updatedAt: now,
  };
  await local().set({ [scriptsKey(domainId)]: { ...scripts, [meta.id]: meta }, [codeKey(meta.id)]: "" });
  return meta;
}

export async function updateScriptMeta(
  domainId: string,
  scriptId: string,
  patch: Partial<Pick<ScriptMeta, "name" | "world">>,
  now: number = Date.now(),
): Promise<ScriptMeta> {
  const scripts = await readScripts(domainId);
  const current = scripts[scriptId];
  if (!current) throw new Error(`스크립트를 찾을 수 없음: ${scriptId}`);
  const next: ScriptMeta = { ...current, ...patch, updatedAt: now };
  await local().set({ [scriptsKey(domainId)]: { ...scripts, [scriptId]: next } });
  return next;
}

export async function saveCode(domainId: string, scriptId: string, code: string, now: number = Date.now()): Promise<void> {
  const scripts = await readScripts(domainId);
  const current = scripts[scriptId];
  if (!current) throw new Error(`스크립트를 찾을 수 없음: ${scriptId}`);
  await local().set({
    [codeKey(scriptId)]: code,
    [scriptsKey(domainId)]: { ...scripts, [scriptId]: { ...current, updatedAt: now } },
  });
}

export async function deleteScript(domainId: string, scriptId: string): Promise<void> {
  const scripts = await readScripts(domainId);
  const { [scriptId]: _removed, ...rest } = scripts;
  await local().remove(codeKey(scriptId));
  await local().set({ [scriptsKey(domainId)]: rest });
}

export async function applyBatch(set: Record<string, unknown>): Promise<void> {
  await local().set(set);
}
