export type World = "USER_SCRIPT" | "MAIN";

export const WORLD_VALUES: readonly World[] = ["USER_SCRIPT", "MAIN"];

export interface Domain {
  id: string;
  host: string;
  includeSubdomains: boolean;
  createdAt: number;
}

// 스크립트는 자동 실행하지 않는다. 팝업 "실행" 버튼으로만 현재 탭에 주입한다.
export interface ScriptMeta {
  id: string;
  domainId: string;
  name: string;
  world: World;   // execute 시점의 JS world
  updatedAt: number;
}

export interface StorageSnapshot {
  domains: Record<string, Domain>;
  scripts: Record<string, Record<string, ScriptMeta>>; // domainId → scriptId → meta
  code: Record<string, string>; // scriptId → 본문
}

export const SCHEMA_VERSION = 1 as const;

export interface ExportManifest {
  schemaVersion: typeof SCHEMA_VERSION;
  exportedAt: string;
  domains: Array<{
    host: string;
    includeSubdomains: boolean;
    scripts: Array<{
      name: string;
      file: string;
      world: World;
    }>;
  }>;
}
