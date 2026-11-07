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

/**
 * How a template starts its agent headless (`spec.wake`): the program, its
 * argv with `{param}` placeholders, the params a run fills, the environment
 * names to strip. Read as the catalog wrote it; the worker renders it.
 */
export interface AgentWakeSpec {
  program: string;
  args: string[];
  params: Record<string, { type?: string; required?: boolean }>;
  envStrip: string[];
}

export interface AgentTemplateWake {
  slug: string;
  harness: string;
  /** `null`: the template carries no `wake` block (nothing can start it headless). */
  wake: AgentWakeSpec | null;
}

/**
 * The template with this slug in the INSTALLED catalog package, with its wake
 * block. `null` when the package has no such template (or no `agents/`). A
 * malformed wake block THROWS: a template that says it wakes but cannot be
 * read is not "a template without a wake".
 */
export function readAgentTemplateWake(
  slug: string,
  catalogRoot: string | null = resolveInstalledCatalogRoot(),
): AgentTemplateWake | null {
  const dir = catalogRoot ? path.join(catalogRoot, "agents") : null;
  if (!dir || !fs.existsSync(dir)) return null;
  for (const file of fs.readdirSync(dir).sort()) {
    if (!/\.agent\.ya?ml$/.test(file)) continue;
    let doc: AgentManifest & { spec?: { wake?: unknown } };
    try {
      doc = parseYaml(fs.readFileSync(path.join(dir, file), "utf8")) as typeof doc;
    } catch {
      continue; // an unreadable file names nothing; `synap catalog validate` owns it
    }
    if (doc?.kind !== "agent" || doc?.meta?.slug !== slug) continue;
    const harness = typeof doc.spec?.harness === "string" ? doc.spec.harness : slug;
    const raw = doc.spec?.wake as
      | { program?: unknown; args?: unknown; params?: unknown; env?: { strip?: unknown } }
      | undefined
      | null;
    if (raw == null) return { slug, harness, wake: null };
    const args = raw.args ?? [];
    if (typeof raw.program !== "string" || !raw.program || !Array.isArray(args) || !args.every((a) => typeof a === "string")) {
      throw new Error(`The agent template "${slug}" (${file}) has a wake block the worker cannot read: it needs a program and a list of string args.`);
    }
    const params =
      raw.params && typeof raw.params === "object" ? (raw.params as AgentWakeSpec["params"]) : {};
    const strip = Array.isArray(raw.env?.strip) ? raw.env!.strip.filter((s): s is string => typeof s === "string") : [];
    return { slug, harness, wake: { program: raw.program, args: args as string[], params, envStrip: strip } };
  }
  return null;
}
