/**
 * The installed `@synap-core/workspace-templates` version — the "is my bundle
 * stale?" winner signal the catalog merge door compares against each CP row's
 * `sourcePackage.version`.
 *
 * Resolved from the installed package.json. The package subpath is blocked by
 * `exports`, so we walk up from the resolved entry. On failure we return "" —
 * unparseable ⇒ the door keeps the bundle (safe default). Shared by `launch`
 * and `market` so there is ONE copy.
 */

import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";

export function bundledTemplatesVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    let dir = path.dirname(require.resolve("@synap-core/workspace-templates"));
    for (let i = 0; i < 6; i++) {
      const pj = path.join(dir, "package.json");
      if (fs.existsSync(pj)) {
        const parsed = JSON.parse(fs.readFileSync(pj, "utf8")) as {
          name?: string;
          version?: string;
        };
        if (parsed.name === "@synap-core/workspace-templates") return parsed.version ?? "";
      }
      dir = path.dirname(dir);
    }
  } catch {
    /* fall through to the safe default */
  }
  return "";
}
