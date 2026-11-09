/**
 * Where a capability's manifest is read when no job carries it: a `synap tools
 * --dry-run`, and the check of a prerequisite (`placement.requires.capabilities`)
 * before a tool that needs it is installed, at the keyboard AND in the worker.
 * It lives beside the runner (not in `commands/`) because the runner uses it.
 *
 * A job never installs from this: it runs the manifest as the person approved
 * it. A prerequisite read here is only CHECKED; installing it is its own
 * installation, its own yes on the pod.
 */

import fs from "node:fs";
import path from "node:path";
import { readComputerManifest, type ComputerManifest } from "./tool.js";

export interface ManifestSourceOpts {
  /** A manifest file on disk (a catalog `*.capability.json`), read before anything else. */
  manifest?: string;
}

/**
 * Read the capability's manifest: a file given with `--manifest`, else the
 * catalog (the control plane's package registry, the one catalog), else the
 * catalog package this CLI ships with. Each answer says where it came from.
 */
export async function loadComputerManifest(
  slug: string,
  opts: ManifestSourceOpts = {}
): Promise<{ manifest: ComputerManifest; source: string } | { error: string }> {
  if (opts.manifest) {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(opts.manifest, "utf8"));
    } catch (err) {
      return { error: `could not read ${opts.manifest}: ${(err as Error).message}` };
    }
    const m = readComputerManifest(raw, slug);
    return "error" in m ? m : { manifest: m, source: opts.manifest };
  }
  const tried: string[] = [];
  try {
    const { fetchPackageDefinition } = await import("../cp-packages.js");
    const def = await fetchPackageDefinition(slug);
    if (def) {
      const m = readComputerManifest(def, slug);
      if (!("error" in m)) return { manifest: m, source: "the catalog" };
      tried.push(`the catalog: ${m.error}`);
    } else tried.push("the catalog has no such capability, or could not be reached");
  } catch (err) {
    tried.push(`the catalog: ${(err as Error).message}`);
  }
  const { resolveInstalledCatalogRoot } = await import("../catalog-templates.js");
  const root = resolveInstalledCatalogRoot();
  const file = root ? path.join(root, "capabilities", `${slug}.capability.json`) : undefined;
  if (file && fs.existsSync(file)) {
    const m = readComputerManifest(JSON.parse(fs.readFileSync(file, "utf8")), slug);
    if (!("error" in m)) return { manifest: m, source: "the catalog shipped with this CLI" };
    tried.push(`the shipped catalog: ${m.error}`);
  } else tried.push("the catalog shipped with this CLI does not have it");
  return { error: `no manifest for ${slug} (${tried.join("; ")})` };
}
