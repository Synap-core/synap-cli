/**
 * TRIPWIRE: the CLI holds no copy of catalog content (founder, 5 Nov 2026: one source).
 *
 * The catalog (synap-app `packages/workspace-templates`, npm
 * `@synap-core/workspace-templates`, later `@synap-core/catalog`) is the one
 * home of skills, automations, capabilities, packs and workspace templates. The
 * CLI reads them from the installed package (`src/lib/catalog-templates.ts`). A
 * copy in this repo forks silently: the bookmark-enrichment copy here had missed
 * the catalog's `web.read` fix for three weeks.
 *
 * Both sides are DERIVED, never listed:
 * - the catalog's content is every non-code file of the INSTALLED package outside
 *   `dist/` (its `skills/`, `automations/`, `capabilities/`, `packs/`, and the
 *   workspace templates `src/*.yaml`);
 * - the CLI's files are every file git tracks or would track in this repo.
 * A CLI file is a copy when a path segment is named like a catalog entry (a skill
 * folder, an automation, a capability, a pack, a workspace template), or when its
 * bytes equal a catalog file's (a renamed copy).
 *
 * It runs in CLI CI (the package is a dependency, so it is in node_modules).
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CATALOG_TEMPLATE_PACKAGES, resolveInstalledCatalogRoot } from "../src/lib/catalog-templates.js";

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Code and build output are not content. */
const CODE = /\.(ts|mts|cts|js|mjs|cjs|map)$/;
/** Names too generic to mark a copy. */
const GENERIC = new Set(["README.md", "SKILL.md", ".DS_Store"]);
/** Below this size a byte match is a coincidence, not a copy. */
const MIN_COPY_BYTES = 64;

const sha = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

function catalogContent(root: string): { files: string[]; names: Set<string>; hashes: Set<string> } {
  const files = (fs.readdirSync(root, { recursive: true }) as string[])
    .filter((rel) => {
      const seg = rel.split(path.sep);
      return seg.length > 1 && seg[0] !== "dist" && seg[0] !== "node_modules" && !CODE.test(rel);
    })
    .filter((rel) => fs.statSync(path.join(root, rel)).isFile());
  const names = new Set<string>();
  for (const rel of files) {
    const seg = rel.split(path.sep);
    // the entry directly in a content folder: skills/<skill>, automations/<file>, src/<template>.yaml
    if (seg[0] !== "src" || seg.length === 2) names.add(seg[1]);
  }
  for (const g of GENERIC) names.delete(g);
  const hashes = new Set<string>();
  for (const rel of files) {
    const buf = fs.readFileSync(path.join(root, rel));
    if (buf.length >= MIN_COPY_BYTES) hashes.add(sha(buf));
  }
  return { files, names, hashes };
}

function cliFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: CLI_ROOT,
    encoding: "utf8",
  })
    .split("\0")
    .filter((f) => f && fs.existsSync(path.join(CLI_ROOT, f)) && fs.statSync(path.join(CLI_ROOT, f)).isFile());
}

describe("the CLI holds no copy of catalog content", () => {
  const root = resolveInstalledCatalogRoot();

  it("reads the real installed catalog (non-vacuity)", () => {
    expect(root, "the catalog package is a CLI dependency and must resolve").not.toBeNull();
    const pkg = JSON.parse(fs.readFileSync(path.join(root!, "package.json"), "utf8"));
    expect(CATALOG_TEMPLATE_PACKAGES).toContain(pkg.name);
    const { files, names } = catalogContent(root!);
    const folders = new Set(files.map((f) => f.split(path.sep)[0]));
    for (const f of ["skills", "automations", "capabilities", "packs", "src"]) expect(folders).toContain(f);
    expect(names).toContain("mail-feed.automation.json");
    expect(names).toContain("stellar-scf-grants-advisor");
    expect(cliFiles()).toContain("src/lib/catalog-templates.ts");
  });

  it("no CLI file is named like a catalog entry or byte-equal to a catalog file", () => {
    const { names, hashes } = catalogContent(root!);
    const copies = new Set<string>();
    for (const f of cliFiles()) {
      const seg = f.split("/");
      const at = seg.findIndex((s) => names.has(s));
      if (at >= 0) {
        copies.add(seg.slice(0, at + 1).join("/"));
        continue;
      }
      const buf = fs.readFileSync(path.join(CLI_ROOT, f));
      if (buf.length >= MIN_COPY_BYTES && hashes.has(sha(buf))) copies.add(f);
    }
    expect(
      [...copies].sort(),
      "These copy the catalog. Delete them and read the installed package (src/lib/catalog-templates.ts); " +
        "content the catalog lacks moves INTO the catalog first (synap-app packages/workspace-templates):",
    ).toEqual([]);
  });
});
