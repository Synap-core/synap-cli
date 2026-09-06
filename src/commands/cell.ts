/**
 * synap cell define
 * synap cell build <entry>
 *
 * Define and bundle frame cells for the Synap runtime.
 *
 * Usage:
 *   synap cell define --name "My Chart" --file ./chart.js [--type-key my-chart] [--deps '{"recharts":"2.12.0"}'] [--workspace <id>] [--open]
 *   synap cell define --name "Deal board" --file ./board.js --view-types kanban,table --content-kind collection
 *   cat chart.js | synap cell define --name "My Chart"
 *
 *   synap cell build ./src/chart.tsx --out ./dist/chart.js
 *   synap cell build ./src/chart.tsx --out ./dist/chart.js --define   # bundle then define
 *
 * API:
 *   POST /api/hub/cells/define — { name, rendererSource, workspaceId?, typeKey?,
 *     description?, defaultSize?, deps?, viewTypes?, contentKind? }
 *
 * DEPS: persisted. (A prior note here claimed `/cells/define` parsed but dropped
 * `deps` — that is STALE as of HEAD: the route forwards `deps` to `defineCell`,
 * which writes `deps: input.deps ?? {}` on both the INSERT and the UPDATE branch,
 * after `validateDeps` runs inside the door.)
 *
 * SELECTABILITY: a cell that declares neither `viewTypes` nor `contentKind`
 * installs cleanly and is then UNPICKABLE — no error, no signal. `viewTypes`
 * lands in `widget_definitions.view_renderer_view_types` (migration 0221) and is
 * what the browser copies onto `viewRenderer.viewTypes`; without it the cell can
 * never be chosen as a view renderer. `contentKind` decides which profile-renderer
 * slot the cell can fill; omitted, the column defaults to `widget`, which is
 * placeable but never offered as an entity-detail/card/profile/collection renderer.
 * Both follow an omit-is-silence rule on an upsert of an EXISTING row: not passing
 * the flag leaves the stored value untouched (so a source-only re-push can't erase
 * a declared affinity). Pass `--view-types ""` to clear the affinity.
 *
 * cell build runtime contract:
 *   - esbuild bundles to a single ESM file (format: esm, bundle: true)
 *   - bare imports (react, react-dom, any non-relative) are externalized
 *   - externalized modules become the deps map (version from package.json if present, else "latest")
 *   - the output module default-exports a React component (or plain module)
 *   - at runtime Synap resolves bare imports via esm.sh importmap
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { dirname, resolve, basename } from "path";
import { log } from "../utils/logger.js";
import {
  resolveHubConfig,
  resolveUserId,
  hubPost,
} from "../lib/hub-client.js";
import { openInBrowser } from "./open.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * The `contentKind` vocabulary — WHAT a cell renders, which decides the
 * profile-renderer slots it can fill.
 *
 * SSOT: `ContentKind` in
 * `synap-backend/packages/database/src/schema/widget-definitions.ts`
 * (canonically mirrored from `@synap-core/capabilities`). This list is a
 * hand-maintained copy because the CLI does not depend on either package; if
 * the union there grows, `test/cell-define-content-kind.test.ts` is the only
 * thing that will catch the drift — keep them together.
 */
export const CONTENT_KINDS = [
  "entity-detail",
  "entity-card",
  "entity-profile",
  "collection",
  "widget",
] as const;

export type ContentKind = (typeof CONTENT_KINDS)[number];

/** Narrow a raw `--content-kind` value against {@link CONTENT_KINDS}. */
export function parseContentKind(raw: string): ContentKind | null {
  const v = raw.trim();
  return (CONTENT_KINDS as readonly string[]).includes(v)
    ? (v as ContentKind)
    : null;
}

/**
 * Parse a `--view-types` list. Comma-separated, trimmed, deduped.
 *
 * `undefined` (flag absent) ⇒ omit the field entirely, so an upsert of an
 * existing row leaves the stored affinity untouched. An EMPTY string ⇒ `[]`,
 * the explicit "clear it" signal the define door documents.
 */
export function parseViewTypes(
  raw: string | undefined
): string[] | undefined {
  if (raw === undefined) return undefined;
  return [
    ...new Set(
      raw
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t !== "")
    ),
  ];
}

export interface CellDefineOpts {
  name: string;
  file?: string;
  typeKey?: string;
  deps?: string;
  viewTypes?: string;
  contentKind?: string;
  workspace?: string;
  description?: string;
  open?: boolean;
  json?: boolean;
  podUrl?: string;
  apiKey?: string;
}

export interface CellBuildOpts {
  out?: string;
  define?: boolean;
  name?: string;
  typeKey?: string;
  deps?: string;
  viewTypes?: string;
  contentKind?: string;
  workspace?: string;
  description?: string;
  open?: boolean;
  json?: boolean;
  podUrl?: string;
  apiKey?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Read source from --file flag or stdin (when piped). */
async function resolveSource(file: string | undefined): Promise<string> {
  if (file) {
    try {
      return readFileSync(file, "utf-8");
    } catch (e) {
      log.error(`Cannot read file: ${file} — ${(e as Error).message}`);
      process.exit(1);
    }
  }
  if (!process.stdin.isTTY) {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      process.stdin.on("data", (chunk) => chunks.push(chunk as Buffer));
      process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      process.stdin.on("error", reject);
    });
  }
  log.error("Provide source via --file <path> or pipe stdin.");
  process.exit(1);
}

/**
 * Detect the package.json closest to `entryDir` (walk up).
 * Returns the parsed JSON or null.
 */
function findPackageJson(
  entryDir: string
): Record<string, unknown> | null {
  let dir = entryDir;
  for (let i = 0; i < 10; i++) {
    const candidate = resolve(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        return JSON.parse(readFileSync(candidate, "utf-8")) as Record<
          string,
          unknown
        >;
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Collect version for `pkg` from a package.json deps map. */
function lookupVersion(
  pkg: Record<string, unknown>,
  name: string
): string {
  const deps = {
    ...((pkg.dependencies as Record<string, string>) ?? {}),
    ...((pkg.devDependencies as Record<string, string>) ?? {}),
    ...((pkg.peerDependencies as Record<string, string>) ?? {}),
  };
  const raw = deps[name];
  if (!raw) return "latest";
  // Strip semver range prefixes (^, ~, >=, etc.)
  return raw.replace(/^[^0-9]*/, "") || "latest";
}

/** Call esbuild programmatically. Returns { code, externals }. */
async function bundleWithEsbuild(
  entry: string
): Promise<{ code: string; externals: string[] }> {
  // Dynamic import so the CLI only requires esbuild when `cell build` is used.
  let esbuild: typeof import("esbuild");
  try {
    esbuild = await import("esbuild");
  } catch {
    log.error(
      "esbuild is not installed. Run: npm install -D esbuild  (or pnpm add -D esbuild)"
    );
    process.exit(1);
  }

  // First pass: bundle without any externals to discover all bare imports.
  // We use a custom plugin to collect them instead of failing.
  const externalSet = new Set<string>();

  const collectPlugin: import("esbuild").Plugin = {
    name: "collect-externals",
    setup(build) {
      // Intercept every non-relative, non-absolute import
      build.onResolve({ filter: /^[^./]/ }, (args) => {
        // Extract the package name (handle scoped packages like @org/pkg)
        const parts = args.path.split("/");
        const pkgName =
          args.path.startsWith("@") && parts.length >= 2
            ? `${parts[0]}/${parts[1]}`
            : parts[0];
        externalSet.add(pkgName ?? args.path);
        return { path: args.path, external: true };
      });
    },
  };

  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    write: false,
    plugins: [collectPlugin],
    logLevel: "silent",
  });

  if (result.errors.length > 0) {
    const msgs = result.errors.map((e) => e.text).join("\n");
    log.error(`esbuild failed:\n${msgs}`);
    process.exit(1);
  }

  const code = result.outputFiles[0]?.text ?? "";
  return { code, externals: Array.from(externalSet).sort() };
}

// ─── cell define ──────────────────────────────────────────────────────────────

export async function cellDefine(opts: CellDefineOpts): Promise<void> {
  try {
    const rendererSource = await resolveSource(opts.file);
    const cfg = await resolveHubConfig(opts);
    const userId = await resolveUserId(cfg);
    const workspaceId = opts.workspace ?? cfg.workspaceId;

    // Parse --deps if provided
    let parsedDeps: Record<string, string> = {};
    if (opts.deps) {
      try {
        parsedDeps = JSON.parse(opts.deps) as Record<string, string>;
      } catch {
        log.error(`--deps must be valid JSON, e.g. '{"recharts":"2.12.0"}'`);
        process.exit(1);
      }
    }

    // Validate --content-kind against the real union BEFORE the round trip: the
    // define door's zod would otherwise strip an unknown value silently and the
    // cell would install unpickable — the exact failure this flag exists to stop.
    let contentKind: ContentKind | undefined;
    if (opts.contentKind !== undefined) {
      const parsed = parseContentKind(opts.contentKind);
      if (!parsed) {
        log.error(
          `--content-kind must be one of: ${CONTENT_KINDS.join(", ")} (got "${opts.contentKind}")`
        );
        process.exit(1);
      }
      contentKind = parsed;
    }
    const viewTypes = parseViewTypes(opts.viewTypes);

    const body: Record<string, unknown> = {
      userId,
      name: opts.name,
      rendererSource,
      deps: parsedDeps,
    };
    if (workspaceId) body.workspaceId = workspaceId;
    if (opts.typeKey) body.typeKey = opts.typeKey;
    if (opts.description) body.description = opts.description;
    // Omit-is-silence: only send these when the caller actually spoke about
    // them, so a plain source re-push never erases a declared affinity/slot.
    if (viewTypes !== undefined) body.viewTypes = viewTypes;
    if (contentKind !== undefined) body.contentKind = contentKind;

    const res = (await hubPost("/cells/define", body, cfg)) as Record<
      string,
      unknown
    >;

    const isProposed = res.status === "proposed" || Boolean(res.proposalId);
    if (isProposed) {
      log.warn(`Queued for approval (proposal: ${String(res.proposalId ?? "")})`);
      if (res.reviewUrl) log.dim(`  Review: ${String(res.reviewUrl)}`);
      return;
    }

    const typeKey = String(res.typeKey ?? "");

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            typeKey,
            name: opts.name,
            deps: parsedDeps,
            ...(viewTypes !== undefined ? { viewTypes } : {}),
            ...(contentKind !== undefined ? { contentKind } : {}),
          },
          null,
          2
        )
      );
      return;
    }

    if (!typeKey) {
      log.error("Cell defined but no typeKey returned");
      return;
    }

    log.success(`Cell defined: ${opts.name}`);
    log.dim(`  typeKey: ${typeKey}`);
    if (Object.keys(parsedDeps).length > 0)
      log.dim(`  deps: ${JSON.stringify(parsedDeps)}`);
    if (viewTypes !== undefined)
      log.dim(
        `  view types: ${viewTypes.length > 0 ? viewTypes.join(", ") : "(cleared)"}`
      );
    if (contentKind !== undefined) log.dim(`  content kind: ${contentKind}`);
    // Say it once, at define time, when the author can still act on it — a cell
    // with neither is placeable on a bento but can never be PICKED as a view or
    // profile renderer, and nothing downstream ever reports that.
    if (viewTypes === undefined && contentKind === undefined) {
      log.dim(
        `  note: no --view-types / --content-kind — this cell is placeable but not selectable as a renderer`
      );
    }
    log.dim(`  bento block: { kind: "${typeKey}", config: {} }`);
    log.dim(`  open in browser: synap open cell ${typeKey}`);

    if (opts.open && typeKey) {
      await openInBrowser({ kind: "cell", id: typeKey });
    }
  } catch (e) {
    log.error("Error: " + (e as Error).message);
    process.exit(1);
  }
}

// ─── cell build ───────────────────────────────────────────────────────────────

export async function cellBuild(
  entry: string,
  opts: CellBuildOpts
): Promise<void> {
  try {
    const absEntry = resolve(process.cwd(), entry);
    if (!existsSync(absEntry)) {
      log.error(`Entry file not found: ${absEntry}`);
      process.exit(1);
    }

    log.dim(`Bundling ${entry}…`);
    const { code, externals } = await bundleWithEsbuild(absEntry);

    // Build deps map: externals → version from nearest package.json
    const pkgJson = findPackageJson(dirname(absEntry));
    const depsMap: Record<string, string> = {};
    for (const ext of externals) {
      depsMap[ext] = pkgJson ? lookupVersion(pkgJson, ext) : "latest";
    }

    // Honour explicit --deps overrides
    if (opts.deps) {
      let override: Record<string, string>;
      try {
        override = JSON.parse(opts.deps) as Record<string, string>;
      } catch {
        log.error(`--deps must be valid JSON, e.g. '{"recharts":"2.12.0"}'`);
        process.exit(1);
      }
      Object.assign(depsMap, override);
    }

    // Write output file
    const outPath = opts.out
      ? resolve(process.cwd(), opts.out)
      : resolve(dirname(absEntry), basename(absEntry).replace(/\.[^.]+$/, ".bundle.js"));

    writeFileSync(outPath, code, "utf-8");

    if (opts.json) {
      console.log(JSON.stringify({ out: outPath, deps: depsMap }, null, 2));
    } else {
      log.success(`Bundled → ${outPath}`);
      log.dim(`  size: ${(code.length / 1024).toFixed(1)} KB`);
      if (externals.length > 0) {
        log.dim(`  externals (runtime deps via esm.sh):`);
        for (const [k, v] of Object.entries(depsMap)) {
          log.dim(`    ${k}@${v}`);
        }
      } else {
        log.dim(`  no external deps`);
      }
      log.dim(`  deps JSON: ${JSON.stringify(depsMap)}`);
    }

    // --define: pipe straight into cell define
    if (opts.define) {
      if (!opts.name) {
        log.error("--define requires --name <name>");
        process.exit(1);
      }
      log.dim(`\nDefining cell on pod…`);
      await cellDefine({
        name: opts.name,
        file: outPath,
        typeKey: opts.typeKey,
        deps: JSON.stringify(depsMap),
        viewTypes: opts.viewTypes,
        contentKind: opts.contentKind,
        workspace: opts.workspace,
        description: opts.description,
        open: opts.open,
        json: opts.json,
        podUrl: opts.podUrl,
        apiKey: opts.apiKey,
      });
    }
  } catch (e) {
    log.error("Error: " + (e as Error).message);
    process.exit(1);
  }
}
