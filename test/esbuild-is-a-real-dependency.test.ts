import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * `esbuild` powers `cell build` and `market publish`'s `codeFile` bundling —
 * the ONLY way either can work is if esbuild is resolvable from the CLI's
 * OWN install location, which Node only guarantees for a real `dependency`.
 * As a `devDependency`, it is present in this repo's own node_modules during
 * development and tests, but absent wherever the CLI is actually
 * distributed and run (`npx @synap-core/cli`, a global `npm install -g`) —
 * so the CLI's own error message ("run npm install -D esbuild") told the
 * user to install it in the WRONG package; it needed to be beside the CLI's
 * own `dist/`, not in the user's project.
 */
const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(here, "../package.json"), "utf8"));

describe("esbuild ships as a real dependency, not a devDependency", () => {
  it("is listed under dependencies", () => {
    expect(pkg.dependencies.esbuild).toBeTruthy();
  });

  it("is not also listed under devDependencies", () => {
    expect(pkg.devDependencies.esbuild).toBeUndefined();
  });
});
