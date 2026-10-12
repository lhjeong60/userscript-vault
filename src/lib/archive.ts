import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import {
  SCHEMA_VERSION, WORLD_VALUES,
  type Domain, type ExportManifest, type ScriptMeta, type StorageSnapshot, type World,
} from "./types";
import { normalizeHost } from "./host";
import { patternsFor } from "./patterns";
import { scriptsKey, codeKey } from "./storage";

const FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f]/g;
const EDGE_TRIM = /^[\s.]+|[\s.]+$/g;
const FALLBACK_NAME = "script";
const MANIFEST_FILE = "export.json";

export function safeFileName(name: string): string {
  const cleaned = name.replace(FORBIDDEN, "_").replace(EDGE_TRIM, "");
  return cleaned.length > 0 ? cleaned : FALLBACK_NAME;
}

function uniqueFileNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    const base = safeFileName(name);
    let candidate = base;
    for (let n = 2; used.has(candidate); n++) candidate = `${base}-${n}`;
    used.add(candidate);
    return candidate;
  });
}

export function buildExport(snapshot: StorageSnapshot, now: Date): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const domains: ExportManifest["domains"] = Object.values(snapshot.domains).map((domain) => {
    const metas = Object.values(snapshot.scripts[domain.id] ?? {});
    const fileNames = uniqueFileNames(metas.map((m) => m.name));
    const scripts = metas.map((meta, i) => {
      const file = `${domain.host}/${fileNames[i]}.js`;
      files[file] = strToU8(snapshot.code[meta.id] ?? "");
      return { name: meta.name, file, world: meta.world };
    });
    return { host: domain.host, includeSubdomains: domain.includeSubdomains, scripts };
  });
  const manifest: ExportManifest = { schemaVersion: SCHEMA_VERSION, exportedAt: now.toISOString(), domains };
  files[MANIFEST_FILE] = strToU8(JSON.stringify(manifest, null, 2));
  return zipSync(files);
}

export interface ParsedScript { name: string; world: World; code: string }
export interface ParsedDomain { host: string; includeSubdomains: boolean; scripts: ParsedScript[] }
export interface ParsedImport { domains: ParsedDomain[]; skipped: string[] }
export type ParseResult = { ok: true; value: ParsedImport } | { ok: false; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function pickEnum<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export function parseImport(bytes: Uint8Array): ParseResult {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    return { ok: false, error: "zip 파일을 읽을 수 없습니다" };
  }
  const raw = files[MANIFEST_FILE];
  if (!raw) return { ok: false, error: "export.json이 없습니다" };

  let manifest: unknown;
  try {
    manifest = JSON.parse(strFromU8(raw));
  } catch {
    return { ok: false, error: "export.json이 올바른 JSON이 아닙니다" };
  }
  if (!isRecord(manifest) || manifest.schemaVersion !== SCHEMA_VERSION || !Array.isArray(manifest.domains)) {
    const version = isRecord(manifest) ? String(manifest.schemaVersion) : "?";
    return { ok: false, error: `지원하지 않는 형식입니다 (schemaVersion ${version})` };
  }

  const skipped: string[] = [];
  const domains: ParsedDomain[] = [];
  for (const d of manifest.domains) {
    if (!isRecord(d) || typeof d.host !== "string") {
      skipped.push("호스트가 없는 도메인 항목");
      continue;
    }
    const host = normalizeHost(d.host);
    if (!host.ok) {
      skipped.push(`잘못된 호스트: ${d.host}`);
      continue;
    }
    const scripts: ParsedScript[] = [];
    for (const s of Array.isArray(d.scripts) ? d.scripts : []) {
      if (!isRecord(s) || typeof s.name !== "string" || typeof s.file !== "string") {
        skipped.push(`${host.host}: 이름 또는 파일이 없는 스크립트`);
        continue;
      }
      const body = Object.hasOwn(files, s.file) ? files[s.file] : undefined;
      if (!body) {
        skipped.push(`${host.host}/${s.name}: 파일 없음 (${s.file})`);
        continue;
      }
      scripts.push({
        name: s.name,
        world: pickEnum(WORLD_VALUES, s.world, "USER_SCRIPT"),
        code: strFromU8(body),
      });
    }
    domains.push({ host: host.host, includeSubdomains: d.includeSubdomains === true, scripts });
  }
  return { ok: true, value: { domains, skipped } };
}

export type ConflictPolicy = "overwrite" | "skip";

export interface ImportPlan {
  set: Record<string, unknown>;
  newOrigins: string[];
  summary: { added: number; overwritten: number; skipped: number };
}

export function planImport(
  parsed: ParsedImport,
  snapshot: StorageSnapshot,
  policy: ConflictPolicy,
  now: number,
  newId: () => string = () => crypto.randomUUID(),
): ImportPlan {
  const domains: Record<string, Domain> = { ...snapshot.domains };
  const scriptsByDomain: Record<string, Record<string, ScriptMeta>> = {};
  const claimedByDomain: Record<string, Set<string>> = {}; // 이미 가져오기 항목과 짝지어진 기존 스크립트 id
  const set: Record<string, unknown> = {};
  const newOrigins: string[] = [];
  const summary = { added: 0, overwritten: 0, skipped: parsed.skipped.length };

  for (const pd of parsed.domains) {
    const found = Object.values(domains).find((d) => d.host === pd.host);
    const domain: Domain = found ?? {
      id: newId(), host: pd.host, includeSubdomains: pd.includeSubdomains, createdAt: now,
    };
    if (!found) {
      domains[domain.id] = domain;
      newOrigins.push(...patternsFor(domain));
    }

    // 같은 host가 export.json에 여러 번 나와도 한 맵에 누적한다.
    const scripts = (scriptsByDomain[domain.id] ??= { ...(snapshot.scripts[domain.id] ?? {}) });
    const claimed = (claimedByDomain[domain.id] ??= new Set<string>());
    const originals = Object.values(snapshot.scripts[domain.id] ?? {});

    for (const ps of pd.scripts) {
      // 기존(가져오기 전) 스크립트와만 이름을 맞춘다. 기존 스크립트 하나는 한 항목에만 짝지어진다.
      const existing = originals.find((s) => s.name === ps.name && !claimed.has(s.id));
      if (existing) claimed.add(existing.id);
      if (existing && policy === "skip") {
        summary.skipped++;
        continue;
      }
      const id = existing?.id ?? newId();
      scripts[id] = { id, domainId: domain.id, name: ps.name, world: ps.world, updatedAt: now };
      set[codeKey(id)] = ps.code;
      if (existing) summary.overwritten++;
      else summary.added++;
    }
    set[scriptsKey(domain.id)] = scripts;
  }
  set.domains = domains;
  return { set, newOrigins, summary };
}
