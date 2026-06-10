/**
 * synap cell define
 * synap cell build <entry>
 *
 * Define and bundle frame cells for the Synap runtime.
 *
 * Usage:
 *   synap cell define --name "My Chart" --file ./chart.js [--type-key my-chart] [--deps '{"recharts":"2.12.0"}'] [--workspace <id>] [--open]
 *   cat chart.js | synap cell define --name "My Chart"
 *
 *   synap cell build ./src/chart.tsx --out ./dist/chart.js
 *   synap cell build ./src/chart.tsx --out ./dist/chart.js --define   # bundle then define
 *
 * API:
 *   POST /api/hub/cells/define — { name, rendererSource, workspaceId?, typeKey?, description?, defaultSize? }
 *
 * NOTE on deps: The /cells/define endpoint currently ignores the `deps` field in
 * the Zod schema (parsed but not persisted — the INSERT always uses `deps: {}`).
 * We send it anyway so the payload is ready when the backend adds support.
 * Track: cells.ts upsert sets `deps: {} as Record<string, string>` unconditionally.
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

export interface CellDefineOpts {
  name: string;
  file?: string;
  typeKey?: string;
  deps?: string;
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

    const body: Record<string, unknown> = {
      userId,
      name: opts.name,
      rendererSource,
      // deps is sent even though the current backend ignores it (see file-level note).
      deps: parsedDeps,
    };
    if (workspaceId) body.workspaceId = workspaceId;
    if (opts.typeKey) body.typeKey = opts.typeKey;
    if (opts.description) body.description = opts.description;

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
      console.log(JSON.stringify({ typeKey, name: opts.name, deps: parsedDeps }, null, 2));
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
