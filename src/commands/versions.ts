/**
 * synap versions
 * ===============
 *
 * Answers "what version of each Synap artifact is LOCAL vs NPM vs
 * CONTROL-PLANE vs POD" in one glance — the question `market update` can't
 * answer because it only looks at what's already installed on the active pod,
 * not whether the CP itself is seeded from a stale npm version. That gap is
 * exactly how a publish can silently fail to propagate (e.g. templates
 * published to npm 0.6.4 while the CP is still seeded from 0.5.0).
 *
 * READ-ONLY: every network call here is a GET (or `npm view`, which never
 * mutates the registry). No pod/CP mutation, no writes anywhere.
 *
 * Reuses rather than re-derives:
 *   - `bundledTemplatesVersion()` (lib/bundle-version.ts) for the LOCAL
 *     workspace-templates version.
 *   - `fetchInstalledTemplates()` (lib/installed.ts) for the POD stamp summary.
 *   - `computeTemplateUpdates`/`isHashVersion` (@synap-core/workspace-templates)
 *     for the actual semver comparison — the same comparator `market update`
 *     already uses. Comparing two bare version strings is done by feeding them
 *     through that door via `compareVersions()` below rather than
 *     hand-rolling a second semver parser.
 */

import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import chalk from "chalk";
import {
  computeTemplateUpdates,
  isHashVersion,
  type CatalogEntry,
} from "@synap-core/workspace-templates";
import { log, banner } from "../utils/logger.js";
import { bundledTemplatesVersion } from "../lib/bundle-version.js";
import { fetchInstalledTemplates } from "../lib/installed.js";
import { getCpUrl } from "../lib/auth.js";
import { getActivePodConfig } from "../lib/pod.js";

const FETCH_TIMEOUT_MS = 8000;

// ── version lookups ─────────────────────────────────────────────────────────

/** `npm view <pkg> version` — spawned, tolerant of being offline/unpublished. */
function npmViewVersion(pkgName: string): string | undefined {
  try {
    const out = execSync(`npm view ${pkgName} version`, {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/** Best-effort resolve of an installed package's own version, mirroring `bundledTemplatesVersion()`'s walk-up-to-package.json approach for any package name. */
function resolvedLocalVersion(pkgName: string): string | undefined {
  try {
    const req = createRequire(import.meta.url);
    let dir = path.dirname(req.resolve(pkgName));
    for (let i = 0; i < 6; i++) {
      const pj = path.join(dir, "package.json");
      if (fs.existsSync(pj)) {
        const parsed = JSON.parse(fs.readFileSync(pj, "utf8")) as { name?: string; version?: string };
        if (parsed.name === pkgName) return parsed.version ?? undefined;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* not resolvable from this CLI — expected for packages the CLI doesn't depend on */
  }
  return undefined;
}

/**
 * GET {CP}/api/packages/:slug — the CP's own copy of a published package,
 * whose `definition.sourcePackage.version` is the npm version the CP last
 * seeded from (see `packages.ts` publish flow). Tries a short list of known
 * bundled slugs so a CP with one renamed/missing package doesn't blank the
 * whole row.
 */
async function fetchCpSeededVersion(): Promise<{ slug: string; version: string } | undefined> {
  const candidates = ["foundation", "ecosystem", "operations", "crm"];
  for (const slug of candidates) {
    try {
      const res = await fetch(`${getCpUrl()}/api/packages/${encodeURIComponent(slug)}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as {
        package?: { definition?: { sourcePackage?: { version?: string } } };
      };
      const version = data.package?.definition?.sourcePackage?.version;
      if (version) return { slug, version };
    } catch {
      /* try next candidate */
    }
  }
  return undefined;
}

interface PodHealth {
  apiTypesVersion?: string;
}

/** GET {pod}/health — non-fatal on any failure (pod unreachable, older build). */
async function fetchPodHealth(podUrl: string): Promise<PodHealth | undefined> {
  try {
    const res = await fetch(`${podUrl}/health`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return undefined;
    return (await res.json()) as PodHealth;
  } catch {
    return undefined;
  }
}

interface CapabilitiesCatalog {
  total: number;
  hashVersioned: number;
  semverVersioned: number;
}

/** GET {CP}/api/marketplace/capabilities — public, no auth. */
async function fetchCapabilitiesCatalog(): Promise<CapabilitiesCatalog | undefined> {
  try {
    const res = await fetch(`${getCpUrl()}/api/marketplace/capabilities`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { capabilities?: Array<{ version?: string }> };
    const rows = data.capabilities ?? [];
    const hashVersioned = rows.filter((r) => isHashVersion(r.version)).length;
    return { total: rows.length, hashVersioned, semverVersioned: rows.length - hashVersioned };
  } catch {
    return undefined;
  }
}

// ── comparison (reused, not re-derived) ─────────────────────────────────────

/**
 * Is `to` strictly newer than `from`? Routed through the shared
 * `computeTemplateUpdates` comparator (`@synap-core/workspace-templates`) —
 * the same one `market update` uses — instead of a second semver parser.
 * Returns `undefined` when either side is unknown (nothing to compare).
 */
function isNewer(from: string | undefined, to: string | undefined): boolean | undefined {
  if (!from || !to) return undefined;
  const entry: CatalogEntry = {
    slug: "__cmp__",
    name: "cmp",
    tags: [],
    isPrivate: false,
    // `items` became required on `CatalogEntryBase` when the type split into a
    // bundled/remote union (`@synap-core/workspace-templates` 0.11.0). This is a
    // SYNTHETIC entry that exists only to reuse the shared version comparator —
    // it summarises no real package, so `[]` is the honest value, exactly as the
    // field's own contract prescribes for an entry that carries no cells.
    items: [],
    source: "remote",
    remote: { slug: "__cmp__", name: "cmp", definition: { sourcePackage: { version: to } } },
  };
  const [check] = computeTemplateUpdates([{ slug: "__cmp__", version: from }], [entry]);
  return check.updateAvailable;
}

// ── row rendering ───────────────────────────────────────────────────────────

const DASH = chalk.dim("—");

function fmt(v: string | undefined): string {
  return v ? v : DASH;
}

function printRow(label: string, value: string) {
  console.log(`  ${chalk.dim(label.padEnd(16))} ${value}`);
}

interface Drift {
  inSync: boolean;
  message: string;
}

function printVerdict(d: Drift) {
  if (d.inSync) {
    log.success(d.message);
  } else {
    log.warn(d.message);
  }
}

// ── artifact 1: workspace-templates ─────────────────────────────────────────

interface WorkspaceTemplatesRow {
  name: "workspace-templates";
  local?: string;
  npm?: string;
  cp?: string;
  cpSlug?: string;
  pod?: string;
  drift: Drift;
}

async function checkWorkspaceTemplates(): Promise<WorkspaceTemplatesRow> {
  const local = bundledTemplatesVersion() || undefined;
  const npm = npmViewVersion("@synap-core/workspace-templates");
  const [cpInfo, installed] = await Promise.all([
    fetchCpSeededVersion(),
    fetchInstalledTemplates(),
  ]);
  const stamped = installed.filter((t) => t.version);
  const pod =
    installed.length > 0
      ? `${stamped.length}/${installed.length} stamped`
      : undefined;

  const cpBehindNpm = isNewer(cpInfo?.version, npm);
  const localBehindNpm = isNewer(local, npm);

  let drift: Drift;
  if (!npm) {
    drift = { inSync: false, message: "? npm unreachable — cannot verify drift" };
  } else if (cpBehindNpm) {
    drift = {
      inSync: false,
      message: `CP is behind npm (seeded ${cpInfo?.version}, latest ${npm}) — redeploy CP to propagate`,
    };
  } else if (cpInfo === undefined) {
    drift = { inSync: false, message: "? CP has no known template package — cannot verify CP drift" };
  } else if (localBehindNpm) {
    drift = {
      inSync: false,
      message: `Local CLI bundle is behind npm (local ${local}, latest ${npm}) — update @synap-core/workspace-templates`,
    };
  } else {
    drift = { inSync: true, message: "in sync" };
  }

  return { name: "workspace-templates", local, npm, cp: cpInfo?.version, cpSlug: cpInfo?.slug, pod, drift };
}

// ── artifact 2: api-types ───────────────────────────────────────────────────

interface ApiTypesRow {
  name: "api-types";
  local?: string;
  npm?: string;
  pod?: string;
  drift: Drift;
}

async function checkApiTypes(podUrl: string | undefined): Promise<ApiTypesRow> {
  const local = resolvedLocalVersion("@synap-core/api-types");
  const npm = npmViewVersion("@synap-core/api-types");
  const health = podUrl ? await fetchPodHealth(podUrl) : undefined;
  const pod = health?.apiTypesVersion;

  const podBehindNpm = isNewer(pod, npm);

  let drift: Drift;
  if (!npm) {
    drift = { inSync: false, message: "? npm unreachable — cannot verify drift" };
  } else if (!pod) {
    drift = { inSync: false, message: podUrl ? "? pod unreachable/older build — no apiTypesVersion reported" : "? no pod connected" };
  } else if (podBehindNpm) {
    drift = {
      inSync: false,
      message: `Pod is behind npm (pod reports ${pod}, latest ${npm}) — bump the apiTypesVersion literal in synap-backend and redeploy`,
    };
  } else {
    drift = { inSync: true, message: "in sync" };
  }

  return { name: "api-types", local, npm, pod, drift };
}

// ── artifact 3: capabilities ────────────────────────────────────────────────

interface CapabilitiesRow {
  name: "capabilities";
  cp?: string;
  pod?: string;
  drift: Drift;
}

async function checkCapabilities(): Promise<CapabilitiesRow> {
  const cat = await fetchCapabilitiesCatalog();
  const cp = cat
    ? `${cat.total} published${cat.hashVersioned > 0 ? ` (${cat.hashVersioned} hash-versioned, ${cat.semverVersioned} semver)` : ""}`
    : undefined;
  const pod = "n/a, see synap status";

  const drift: Drift = cat
    ? { inSync: true, message: cat.total > 0 ? `${cat.total} capabilities published to CP` : "no capabilities published" }
    : { inSync: false, message: "? CP capability catalog unreachable" };

  return { name: "capabilities", cp, pod, drift };
}

// ── entrypoint ───────────────────────────────────────────────────────────────

export async function versions(opts: { json?: boolean } = {}): Promise<void> {
  const localConfig = getActivePodConfig();
  const podUrl = localConfig?.podUrl ?? process.env.SYNAP_POD_URL;

  const [wt, at, cap] = await Promise.all([
    checkWorkspaceTemplates(),
    checkApiTypes(podUrl),
    checkCapabilities(),
  ]);

  if (opts.json) {
    const artifacts = [
      { name: wt.name, local: wt.local ?? null, npm: wt.npm ?? null, cp: wt.cp ?? null, pod: wt.pod ?? null, drift: wt.drift },
      { name: at.name, local: at.local ?? null, npm: at.npm ?? null, cp: null, pod: at.pod ?? null, drift: at.drift },
      { name: cap.name, local: null, npm: null, cp: cap.cp ?? null, pod: cap.pod ?? null, drift: cap.drift },
    ];
    process.stdout.write(JSON.stringify({ artifacts }, null, 2) + "\n");
    return;
  }

  banner();
  log.dim("Version status across LOCAL / NPM / CONTROL-PLANE / POD for each Synap artifact.");

  log.heading("workspace-templates");
  printRow("LOCAL", fmt(wt.local));
  printRow("NPM", fmt(wt.npm));
  printRow("CP", wt.cp ? `${wt.cp}${wt.cpSlug ? chalk.dim(` (seeded via "${wt.cpSlug}")`) : ""}` : DASH);
  printRow("POD", fmt(wt.pod));
  printVerdict(wt.drift);

  log.heading("api-types");
  printRow("LOCAL", at.local ? at.local : chalk.dim("not installed in this CLI"));
  printRow("NPM", fmt(at.npm));
  printRow("POD", fmt(at.pod));
  printVerdict(at.drift);

  log.heading("capabilities");
  printRow("CP", fmt(cap.cp));
  printRow("POD", chalk.dim(cap.pod ?? ""));
  printVerdict(cap.drift);

  log.blank();
}
