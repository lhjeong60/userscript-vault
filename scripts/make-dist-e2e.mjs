// e2e 전용 빌드 복사본. 네이티브 권한 프롬프트는 자동화할 수 없으므로 host_permissions를 정적으로 부여한다.
// 실제 배포 빌드(dist/)에는 절대 적용하지 않는다. 권한 프롬프트 흐름은 docs/manual-qa.md로 확인한다.
import { cpSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "dist");
const out = join(root, "dist-e2e");

rmSync(out, { recursive: true, force: true });
cpSync(src, out, { recursive: true });

const manifestPath = join(out, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.name = `${manifest.name} (e2e)`;
manifest.host_permissions = ["<all_urls>"];
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log("dist-e2e ready");
