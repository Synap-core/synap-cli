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
 *   synap cell build ./src/chart.tsx --out ./dist/chart.js --bundle-deps   # no esm.sh at runtime
 *   synap cell build ./src/card.tsx --out ./dist/card.html --self-contained  # one HTML doc (mcp-app)
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
 *   - default mode: every bare import (react, react-dom, any non-relative) is
 *     externalized; externalized modules become the deps map (version from
 *     package.json if present, else "latest"); at runtime Synap resolves
 *     them via esm.sh importmap
 *   - `--bundle-deps` mode: only react/react-dom are externalized (they are
 *     host-inlined at runtime, never via esm.sh — see
 *     `synap-app/packages/core/cell-runtime/src/frame-react-modules.ts`);
 *     every other bare import is bundled into the output, so the deps map is
 *     `{}` and the frame's runtime CSP drops esm.sh entirely (see
 *     `ViewFrame.buildFrameCsp`'s `fullyBundled` branch) — this mode is
 *     opt-in; the default build is byte-identical to before this flag existed
 *   - the output module default-exports a React component (or plain module)
 *   - default and `--bundle-deps` modes REFUSE an imported `.css` file (a
 *     `CellBundleError` naming it): the output is one JS module with nowhere to
 *     put a stylesheet, so the CSS could only be lost. `--self-contained` is the
 *     mode that keeps it.
 *   - `--self-contained` mode (an `rendererType: "mcp-app"` cell — a foreign
 *     MCP-Apps host loads ONE sandboxed HTML document whose CSP admits no
 *     esm.sh, no Google Fonts, no host-supplied React): NOTHING is external —
 *     React included. Imported CSS is collected and inlined in `<style>`, the
 *     brand faces (`@synap-core/design-tokens/fonts`, base64 woff2) are
 *     prepended when they resolve from the entry's package, and the result is
 *     wrapped into a complete HTML document whose inline `<script
 *     type="module">` is the bundle. The output (the cell `code`) IS that
 *     document; `deps` is always `{}`. The entry is the document's only script,
 *     so it must mount itself (a `#root` element is provided).
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { dirname, resolve, basename } from "path";
import { runInNewContext } from "vm";
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
  bundleDeps?: boolean;
  /** One complete HTML document, nothing external (an `mcp-app` cell). */
  selfContained?: boolean;
  /** `--self-contained` only: `false` skips the brand faces; `true` requires them. */
  fonts?: boolean;
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

/**
 * Thrown by `bundleWithEsbuild`/`buildCellFromSource` instead of exiting the
 * process, so a caller that is NOT the direct `cell build` CLI entry point
 * (namely `resolveCellCodeFiles` on the `market publish` path) can turn a
 * bundle failure into its own structured `{ ok: false, ... }` envelope rather
 * than have the process die out from under it before that envelope is ever
 * built. `cellBuild` (the direct entry point) catches this like any other
 * error and still exits 1 — interactive behaviour is unchanged.
 */
export class CellBundleError extends Error {}

/**
 * Package names that stay external even under `--bundle-deps` — the modules
 * the FRAME HOST provides at runtime, which must never be pulled from
 * node_modules: react/react-dom are host-inlined (`synap-app/packages/core/
 * cell-runtime/src/frame-react-modules.ts`), and `@synap/view-sdk` is
 * host-supplied via the iframe import map (`.../frame-import-map.ts`,
 * `imports['@synap/view-sdk'] = blobs.viewSdk`). Externalizing all three
 * costs nothing and keeps the bundle small; failing to list one here means
 * `--bundle-deps` (now the DEFAULT for `market publish` cells) can never
 * build a cell that imports it — esbuild tries to resolve it from
 * node_modules and fails, dead on arrival.
 *
 * This set is a hand-maintained mirror of `frame-import-map.ts` — exactly the
 * drift class this repo keeps losing to — so `frame-import-map-parity.test.ts`
 * reads that file's own source across the repo boundary and fails the moment
 * the host starts supplying a module this set doesn't know about.
 */
export const BUNDLE_DEPS_KEEP_EXTERNAL = new Set([
  "react",
  "react-dom",
  "@synap/view-sdk",
]);

/** Load esbuild from the CLI's own install. */
async function loadEsbuild(): Promise<typeof import("esbuild")> {
  // Dynamic import so the CLI only requires esbuild when `cell build` is used.
  // esbuild is a real `dependency` of this package (not a devDependency) —
  // Node resolves it from the CLI's OWN install location, not the caller's
  // project, so it is present under `npx @synap-core/cli` too. This catch is
  // therefore a last-resort guard against a corrupted install, not the
  // expected path; the fix is reinstalling the CLI, not the user's project.
  try {
    return await import("esbuild");
  } catch {
    throw new CellBundleError(
      "esbuild failed to load from the CLI's own install. Reinstall the CLI (npm install -g @synap-core/cli) or re-run via npx."
    );
  }
}

/**
 * Asset types a self-contained build inlines as `data:` URIs — a stylesheet's
 * `url(./icon.svg)` or `@font-face` src has no origin to load from inside the
 * host's sandbox.
 */
const SELF_CONTAINED_ASSET_LOADERS: Record<string, "dataurl"> = {
  ".woff2": "dataurl",
  ".woff": "dataurl",
  ".ttf": "dataurl",
  ".otf": "dataurl",
  ".png": "dataurl",
  ".jpg": "dataurl",
  ".jpeg": "dataurl",
  ".gif": "dataurl",
  ".webp": "dataurl",
  ".svg": "dataurl",
};

/** `react`, `react-dom`, and any subpath of either (`react/jsx-runtime`, `react-dom/client`, …). */
const REACT_IMPORT = /^react(?:-dom)?(?:\/.*)?$/;

/**
 * Resolve every React import ONCE, from the entry's directory — esbuild's
 * equivalent of Vite's `resolve.dedupe`. Without it, a dependency that imports
 * react without declaring it (in synap-app: spatial-ui → react-dom,
 * proposal-types → react) resolves UPWARD to whatever copy sits nearest to it,
 * and the document ships two Reacts — two dispatchers, so hooks throw. A
 * nested copy is never the one the cell's own tree renders with, so the
 * entry's copy wins; if the entry cannot reach react at all, that is an error
 * here, not a silent fallback to some dependency's copy.
 */
function dedupeReactPlugin(entryDir: string): import("esbuild").Plugin {
  return {
    name: "dedupe-react",
    setup(build) {
      build.onResolve({ filter: REACT_IMPORT }, async (args) => {
        if (args.pluginData?.dedupeReact) return undefined;
        const r = await build.resolve(args.path, {
          kind: args.kind,
          resolveDir: entryDir,
          pluginData: { dedupeReact: true },
        });
        if (r.errors.length > 0) {
          throw new CellBundleError(
            `"${args.path}" (imported by ${args.importer}) does not resolve from the cell entry's directory ${entryDir} — add react/react-dom to the cell's own package so every import shares ONE copy.`
          );
        }
        return { path: r.path, sideEffects: r.sideEffects };
      });
    },
  };
}

/** Call esbuild programmatically. Returns { code, externals, css }. Exported for tests. */
export async function bundleWithEsbuild(
  entry: string,
  opts: { bundleDeps?: boolean; selfContained?: boolean } = {}
): Promise<{ code: string; externals: string[]; css: string }> {
  const esbuild = await loadEsbuild();

  if (opts.selfContained) {
    // No externals: every import — React included — is resolved from the
    // entry's own node_modules and bundled (React deduped to ONE copy, see
    // `dedupeReactPlugin`). An import esbuild cannot
    // resolve (a URL, a missing package) is a build error, never a runtime
    // fetch. `outdir` is virtual (write: false); it only gives esbuild a place
    // to emit the CSS bundle beside the JS one.
    let result: import("esbuild").BuildResult<{ write: false; outdir: string }>;
    try {
      result = await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        format: "esm",
        platform: "browser",
        write: false,
        outdir: "/__synap_cell_out__",
        minify: true,
        // React (and most libs) branch on this; unset, the bundle reads
        // `process` — which does not exist in the host's iframe.
        define: { "process.env.NODE_ENV": '"production"' },
        loader: SELF_CONTAINED_ASSET_LOADERS,
        plugins: [dedupeReactPlugin(dirname(entry))],
        logLevel: "silent",
      });
    } catch (e) {
      throw new CellBundleError(`esbuild failed:\n${(e as Error).message}`);
    }
    const js = result.outputFiles.find((f) => f.path.endsWith(".js"))?.text ?? "";
    const css = result.outputFiles
      .filter((f) => f.path.endsWith(".css"))
      .map((f) => f.text)
      .join("\n");
    return { code: js, externals: [], css };
  }

  // First pass: bundle without any externals to discover all bare imports.
  // We use a custom plugin to collect them instead of failing.
  const externalSet = new Set<string>();
  const cssImports: string[] = [];

  const collectPlugin: import("esbuild").Plugin = {
    name: "collect-externals",
    setup(build) {
      // A stylesheet has nowhere to go in a single-JS-module output: a
      // relative one used to die on esbuild's opaque "without an output path
      // configured", a bare one (`pkg/style.css`) was externalized as an
      // import the runtime cannot load. Collect them and refuse by name below.
      build.onResolve({ filter: /\.css$/ }, (args) => {
        cssImports.push(args.path);
        return { path: args.path, external: true };
      });
      // Intercept every non-relative, non-absolute import
      build.onResolve({ filter: /^[^./]/ }, (args) => {
        // Extract the package name (handle scoped packages like @org/pkg)
        const parts = args.path.split("/");
        const pkgName =
          args.path.startsWith("@") && parts.length >= 2
            ? `${parts[0]}/${parts[1]}`
            : parts[0];
        const name = pkgName ?? args.path;
        // --bundle-deps: only react/react-dom stay external — every other
        // bare import is left unhandled so esbuild resolves + bundles it
        // from node_modules, producing an empty deps map.
        if (opts.bundleDeps && !BUNDLE_DEPS_KEEP_EXTERNAL.has(name)) {
          return undefined;
        }
        externalSet.add(name);
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
    throw new CellBundleError(`esbuild failed:\n${msgs}`);
  }

  if (cssImports.length > 0) {
    throw new CellBundleError(
      `this cell imports CSS, which a single-module build would drop: ${[
        ...new Set(cssImports),
      ].join(", ")}. Build it with --self-contained (CSS inlined into one HTML document), or move the styles into the component.`
    );
  }

  const code = result.outputFiles[0]?.text ?? "";
  return { code, externals: Array.from(externalSet).sort(), css: "" };
}

/** The `@synap-core/design-tokens` export that carries the inlined brand faces. */
export const FONTS_MODULE = "@synap-core/design-tokens/fonts";

/**
 * `SYNAP_FONT_FACE_CSS`, resolved from `fromDir` the way the entry's own
 * imports resolve — or `null` when the package is not reachable from there.
 * The module is TypeScript source (the package ships `src/`), so it is run
 * through esbuild and evaluated in an empty VM context rather than imported.
 */
export async function resolveFontFaceCss(fromDir: string): Promise<string | null> {
  const esbuild = await loadEsbuild();
  let text: string;
  try {
    const r = await esbuild.build({
      stdin: {
        contents: `export { SYNAP_FONT_FACE_CSS } from ${JSON.stringify(FONTS_MODULE)};`,
        resolveDir: fromDir,
        loader: "ts",
      },
      bundle: true,
      format: "cjs",
      platform: "neutral",
      write: false,
      logLevel: "silent",
    });
    text = r.outputFiles[0]?.text ?? "";
  } catch {
    return null;
  }
  const mod: { exports: Record<string, unknown> } = { exports: {} };
  runInNewContext(text, { module: mod, exports: mod.exports });
  const css = mod.exports.SYNAP_FONT_FACE_CSS;
  return typeof css === "string" && css.length > 0 ? css : null;
}

/**
 * Wrap a self-contained bundle into the complete HTML document an MCP-Apps
 * host loads verbatim. `</style` / `</script` are escaped so inlined text can
 * never close its own element early (`<\/` is the same character sequence to
 * the CSS and JS parsers, but not to the HTML tokenizer).
 */
export function wrapSelfContainedHtml(parts: { js: string; css: string }): string {
  const css = parts.css.replace(/<\/(style)/gi, "<\\/$1");
  const js = parts.js.replace(/<\/(script)/gi, "<\\/$1");
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style>\n${css}\n</style>`,
    "</head>",
    "<body>",
    '<div id="root"></div>',
    `<script type="module">\n${js}\n</script>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

export interface BuiltCell {
  code: string;
  /** Externals → version, ready for the `deps` field the runtime resolves via esm.sh. */
  deps: Record<string, string>;
  externals: string[];
}

/**
 * Bundle `entry` and derive its `deps` map — the shared guts behind `cell
 * build` (which additionally writes the result to disk) and `market
 * publish`'s `codeFile` resolution (`lib/kind-package.ts`, which inlines the
 * result straight into a package's `code` field instead). Kept in ONE place
 * because the bundle-deps/react-exclusion derivation below is exactly the
 * seam `cell-build-bundle-deps.test.ts` exists to protect (see its top-of-file
 * comment) — a second copy of this logic is how that bug would come back.
 */
export async function buildCellFromSource(
  entry: string,
  opts: {
    bundleDeps?: boolean;
    deps?: string;
    selfContained?: boolean;
    fonts?: boolean;
  } = {}
): Promise<BuiltCell> {
  if (opts.selfContained) {
    // A self-contained document reaches no module origin, so a deps map —
    // "modules the runtime resolves via esm.sh" — can only be a lie here.
    if (opts.deps) {
      throw new CellBundleError(
        "--deps does not apply to --self-contained: every import is bundled into the document, nothing resolves via esm.sh."
      );
    }
    const { code: js, css } = await bundleWithEsbuild(entry, { selfContained: true });
    let fontCss = "";
    if (opts.fonts !== false) {
      const resolved = await resolveFontFaceCss(dirname(entry));
      if (resolved) fontCss = resolved;
      else if (opts.fonts === true) {
        throw new CellBundleError(
          `--fonts: ${FONTS_MODULE} does not resolve from ${dirname(entry)} — add @synap-core/design-tokens to the cell's package.`
        );
      }
    }
    const code = wrapSelfContainedHtml({
      js,
      css: [fontCss, css].filter(Boolean).join("\n"),
    });
    return { code, deps: {}, externals: [] };
  }

  const { code, externals } = await bundleWithEsbuild(entry, {
    bundleDeps: opts.bundleDeps,
  });

  // Build deps map: externals → version from nearest package.json.
  //
  // Under `--bundle-deps` the react/react-dom externals are DELIBERATELY
  // omitted from this map. They stay external to esbuild (the host supplies
  // them), but the `deps` map means one thing only: "modules the runtime must
  // resolve via the esm.sh import map". React is never one of those — the
  // host inlines it (`frame-react-modules.ts`), and `ViewFrame` will not even
  // build a react-language srcdoc until `reactSources` has loaded.
  //
  // This is the seam that makes the flag WORK: `buildFrameCsp`'s
  // `fullyBundled` branch keys off `Object.keys(deps).length === 0`, so
  // leaving react in the map here would leave `deps = { react: "19" }` and
  // esm.sh would stay in the CSP for every React cell — i.e. the whole
  // feature would be inert on its main use case.
  const pkgJson = findPackageJson(dirname(entry));
  const depsMap: Record<string, string> = {};
  for (const ext of externals) {
    if (opts.bundleDeps && BUNDLE_DEPS_KEEP_EXTERNAL.has(ext)) continue;
    depsMap[ext] = pkgJson ? lookupVersion(pkgJson, ext) : "latest";
  }

  // Honour explicit --deps overrides
  if (opts.deps) {
    let override: Record<string, string>;
    try {
      override = JSON.parse(opts.deps) as Record<string, string>;
    } catch {
      throw new Error(`--deps must be valid JSON, e.g. '{"recharts":"2.12.0"}'`);
    }
    Object.assign(depsMap, override);
  }

  return { code, deps: depsMap, externals };
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
    const { code, deps: depsMap, externals } = await buildCellFromSource(absEntry, {
      bundleDeps: opts.bundleDeps,
      deps: opts.deps,
      selfContained: opts.selfContained,
      fonts: opts.fonts,
    });

    // Write output file
    const outPath = opts.out
      ? resolve(process.cwd(), opts.out)
      : resolve(
          dirname(absEntry),
          basename(absEntry).replace(
            /\.[^.]+$/,
            opts.selfContained ? ".html" : ".bundle.js"
          )
        );

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
