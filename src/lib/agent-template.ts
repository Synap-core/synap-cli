/**
 * The agent template an agent type is an instance of (founder decision D9):
 * `synap agents add` / `connect` / `init` send its slug to `setup/agent`, and
 * the pod applies it inside the SAME approval that connects the agent (one
 * person act, never a second step, never without the first).
 *
 * ONE source: the catalog's `agents/*.agent.yaml`, read from the INSTALLED
 * catalog package (`resolveInstalledCatalogRoot`), never a copy kept here
 * (`catalog-no-copy` tripwire). A template's `spec.harness` (or one of its
 * `aliases`) is the agent type; its `meta.slug` is what the pod links.
 *
 * Nothing found (an older catalog package without `agents/`, an unknown
 * type, two templates claiming one type): `null`, and the request names no
 * template. The pod then links the agent by itself once its catalog installs
 * the template (D10), so a missing answer here never blocks a connect.
 */

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { resolveInstalledCatalogRoot } from "./catalog-templates.js";

interface AgentManifest {
  kind?: unknown;
  meta?: { slug?: unknown };
  spec?: { harness?: unknown; aliases?: unknown };
}

/** Every agent template the installed catalog ships: slug + the types it names. */
export function installedAgentTemplates(
  catalogRoot: string | null = resolveInstalledCatalogRoot(),
): Array<{ slug: string; types: string[] }> {
  const dir = catalogRoot ? path.join(catalogRoot, "agents") : null;
  if (!dir || !fs.existsSync(dir)) return [];
  const out: Array<{ slug: string; types: string[] }> = [];
  for (const file of fs.readdirSync(dir).sort()) {
    if (!/\.agent\.ya?ml$/.test(file)) continue;
    let doc: AgentManifest;
    try {
      doc = parseYaml(fs.readFileSync(path.join(dir, file), "utf8")) as AgentManifest;
    } catch {
      continue; // an unreadable file names nothing; `synap catalog validate` owns it
    }
    const slug = doc?.meta?.slug;
    const harness = doc?.spec?.harness;
    if (doc?.kind !== "agent" || typeof slug !== "string" || typeof harness !== "string") continue;
    const aliases = Array.isArray(doc.spec?.aliases)
      ? (doc.spec!.aliases as unknown[]).filter((a): a is string => typeof a === "string")
      : [];
    out.push({ slug, types: [harness, ...aliases] });
  }
  return out;
}

/** The template slug for an agent type, or null when the catalog names none (or two). */
export function agentTemplateFor(
  agentType: string,
  templates: Array<{ slug: string; types: string[] }> = installedAgentTemplates(),
): string | null {
  const hits = templates.filter((t) => t.types.includes(agentType));
  return hits.length === 1 ? hits[0]!.slug : null;
}
