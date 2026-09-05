/**
 * shared/paths.ts — resolusi akar aplikasi untuk dua mode jalan:
 *
 *   dev      : `bun run src/server/index.ts` / `bun test` — akar = folder repo
 *              (static/index.html ada dua tingkat di atas modul ini).
 *   compiled : `bun build --compile` → exe mandiri (folder release portable) —
 *              akar = folder tempat exe berada; static/ & data/ hidup di
 *              sampingnya. PENTING: import.meta.dir di exe hasil compile TIDAK
 *              menunjuk folder exe (dialihkan ke direktori virtual Bun), dan
 *              Bun.embeddedFiles juga terdefinisi ([] saja) di runtime biasa —
 *              jadi satu-satunya penanda yang bisa diandalkan adalah
 *              process.execPath + keberadaan static/index.html.
 */
import { existsSync } from "fs";
import { dirname, join } from "path";

export function appRoot(): string {
  const exeDir = dirname(process.execPath);
  // Folder release portable: static/ hidup di samping exe.
  if (existsSync(join(exeDir, "static", "index.html"))) return exeDir;
  // Dev: src/shared → repo root.
  const moduleRoot = join(import.meta.dir, "..", "..");
  if (existsSync(join(moduleRoot, "static", "index.html"))) return moduleRoot;
  // Compiled tanpa static/ di samping (kemasan rusak): data/ tetap di exe dir.
  return exeDir;
}
