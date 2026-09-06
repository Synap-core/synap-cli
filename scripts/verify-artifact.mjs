#!/usr/bin/env node
/**
 * Artifact verification for `@synap-core/cli`.
 * ============================================
 *
 * Fails if the tarball a consumer would download declares a dependency range
 * that `npm install` cannot resolve — `workspace:`, `file:`, `link:`,
 * `portal:` — in `dependencies`, `peerDependencies` or `optionalDependencies`
 * (see {@link DEPENDENCY_FIELDS}). Those produce EUNSUPPORTEDPROTOCOL, so the
 * package is on the registry and installable by nobody. It also fails if the
 * declared `bin` targets are not physically in the tarball, which is what stops
 * the range checks passing vacuously on an empty artifact.
 *
 * ⚠️ THIS IS NOT HYPOTHETICAL FOR THIS PACKAGE. Verified against the live
 * registry on 2026-09-05:
 *
 *     npm view @synap-core/cli@1.11.0 dependencies
 *     → '@synap-core/workspace-templates': 'workspace:*'
 *
 * and `npm pack @synap-core/cli@1.11.0` shows only `@synap/hub-rest-client`
 * inside `package/node_modules/` — so the workspace-protocol range is a LIVE,
 * unbundled dependency of the one artifact outsiders are told to install. The
 * CLI has had no CI publish door at all (`synap-cli/` had no `.github/`), and
 * hand-publishing from a laptop is the same proven root cause recorded in
 * synap-backend's `publish-types.yml` header. This script is the backstop for
 * that class; `.github/workflows/publish-cli.yml` is the door.
 *
 * ── TWO MODES, AND WHY BOTH EXIST ────────────────────────────────────────────
 *
 *   --local            pack THIS working tree and inspect the result.
 *                      Runs BEFORE publish, so a bad release is never cut.
 *                      Caveat, borrowed from synap-backend/scripts/
 *                      verify-publishable.mjs: `pnpm pack` rewrites
 *                      `workspace:` while `npm pack` ships it raw, so a local
 *                      pack measures WHICH PACKER YOU RAN. That is precisely
 *                      why this defaults to `npm pack` — the pessimistic
 *                      packer, and the one that actually shipped 1.11.0.
 *
 *   --registry <spec>  download what the registry NOW serves and inspect that.
 *                      Runs AFTER publish. The only ground truth.
 *
 * ── WHY BUNDLED DEPS ARE EXEMPT ──────────────────────────────────────────────
 * `bundledDependencies` ship INSIDE the tarball, under
 * `package/node_modules/<name>`. npm extracts them instead of resolving their
 * range, which is the whole reason `@synap/hub-rest-client` — a package that
 * does not exist on npm at all (404, verified) — can be a `file:` dependency
 * of a published CLI. So this script exempts a forbidden range ONLY when the
 * name is BOTH declared in `bundledDependencies` AND physically present in the
 * tarball. Declaring the bundle without shipping it is the failure this pairing
 * catches: the claim and the bytes are checked together, never the claim alone.
 *
 * Usage:
 *   node scripts/verify-artifact.mjs --local
 *   node scripts/verify-artifact.mjs --registry @synap-core/cli@1.12.0
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Ranges no consumer's `npm install` can resolve. */
const FORBIDDEN_PROTOCOLS = ["workspace:", "file:", "link:", "portal:"];

/**
 * Every manifest field npm resolves ranges from. `dependencies` alone was the
 * original scope and it is not enough: a `workspace:*` under `peerDependencies`
 * or `optionalDependencies` ships to the registry and this script reported the
 * artifact clean. npm 7+ auto-installs peers, so a peer with an unresolvable
 * protocol is EUNSUPPORTEDPROTOCOL for the consumer exactly like a direct one.
 * `devDependencies` is deliberately absent — it is not installed by consumers.
 */
const DEPENDENCY_FIELDS = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
];

const args = process.argv.slice(2);
const mode = args.includes("--registry") ? "registry" : "local";
const spec = mode === "registry" ? args[args.indexOf("--registry") + 1] : null;
if (mode === "registry" && !spec) {
  console.error("--registry needs a <name>@<version> spec");
  process.exit(2);
}

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const work = mkdtempSync(join(tmpdir(), "synap-cli-verify-"));

function sh(cmd, cmdArgs, cwd) {
  return execFileSync(cmd, cmdArgs, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

try {
  // 1. Obtain the tarball.
  if (mode === "local") {
    // `npm pack --pack-destination` rather than `pnpm pack`: see the header.
    // `--ignore-scripts` is NOT passed — `prepack` is what vendors the bundled
    // dependency into node_modules, and skipping it would verify a tarball
    // nobody will ever publish.
    sh("npm", ["pack", "--pack-destination", work], repoRoot);
  } else {
    sh("npm", ["pack", spec], work);
  }
  const tgz = readdirSync(work).find((f) => f.endsWith(".tgz"));
  if (!tgz) throw new Error("no tarball produced");

  // 2. Unpack and read what a consumer would read.
  sh("tar", ["xzf", tgz], work);
  const pkgDir = join(work, "package");
  const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));

  const bundledDeclared = new Set(
    manifest.bundledDependencies ?? manifest.bundleDependencies ?? [],
  );
  const shipped = new Set();
  for (const scope of safeReaddir(join(pkgDir, "node_modules"))) {
    if (scope.startsWith("@")) {
      for (const name of safeReaddir(join(pkgDir, "node_modules", scope))) {
        shipped.add(`${scope}/${name}`);
      }
    } else {
      shipped.add(scope);
    }
  }

  // 3. Judge.
  const problems = [];
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (!FORBIDDEN_PROTOCOLS.some((p) => String(range).startsWith(p))) continue;
      if (bundledDeclared.has(name) && shipped.has(name)) continue; // shipped inline
      problems.push(
        bundledDeclared.has(name)
          ? `${field}.${name}: "${range}" is declared bundled but is NOT in the tarball — npm will try to resolve the range and fail`
          : `${field}.${name}: "${range}" is unresolvable for consumers (EUNSUPPORTEDPROTOCOL) and is not bundled`,
      );
    }
  }

  // Every `bin` target must actually be IN the tarball. Without this the whole
  // script passes vacuously on an empty artifact: no `dependencies` key means
  // no forbidden ranges means "✓ every dependency range is resolvable" — a
  // clean bill of health for a tarball containing nothing a consumer can run.
  // The CI smoke step (`npm install` + `synap --version`) does catch that, but
  // it runs AFTER `npm publish`; this is the same check on the pre-publish side
  // of the door, which is the side that can still stop a bad release.
  const bins =
    typeof manifest.bin === "string"
      ? { [manifest.name]: manifest.bin }
      : (manifest.bin ?? {});
  const binPaths = Object.values(bins);
  if (binPaths.length === 0) {
    problems.push(
      `no "bin" declared — this package's whole purpose is the \`synap\` executable`,
    );
  }
  for (const binPath of binPaths) {
    if (!existsSync(join(pkgDir, binPath))) {
      problems.push(
        `bin target "${binPath}" is declared but is NOT in the tarball — \`npm i -g\` links a path that does not exist`,
      );
    }
  }

  const label = mode === "local" ? "local pack" : spec;
  if (problems.length) {
    console.error(`✗ ${label} is NOT installable:`);
    for (const p of problems) console.error(`  • ${p}`);
    process.exit(1);
  }
  console.error(
    `✓ ${label}: every dependency range is resolvable and every bin target ships` +
      (shipped.size ? ` (bundled inline: ${[...shipped].join(", ")})` : ""),
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
