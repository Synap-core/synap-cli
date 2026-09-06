import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * An install must never assume "workspace" for a package it cannot classify.
 *
 * Found on 2026-09-05 by publishing the first cell package and installing it:
 *
 *   $ synap market publish probe-card-pack.cell.json
 *   ✓ Published probe-card-pack h-15c5ee1c105a (private)
 *   $ synap market install probe-card-pack
 *   ✓ Installed Probe Card Pack (dogfood).
 *
 * No cell landed on the pod. An empty **"New Workspace"** appeared instead.
 * Cause: `typeOf(entry) = entry.category ?? "workspace"`. A PRIVATE package is
 * invisible to the unauthenticated catalog, so its entry carried no category,
 * so the default classified it as a workspace and `/packages/apply` provisioned
 * one — with a success message.
 *
 * Third instance in a single day of the same class: a DEFAULTED DISCRIMINATOR
 * turning "I don't know" into a confident claim (`status ?? "installed"`; an
 * absent `runResult.success` read as failure; and this). "It is a workspace"
 * and "I cannot tell what this is" are different facts and only one is
 * actionable.
 */
const SRC = join(process.cwd(), "src/commands/market.ts");

describe("market install refuses an unclassified package", () => {
  const src = readFileSync(SRC, "utf8");

  it("the source is readable (guards against a vacuous pass)", () => {
    expect(src.length).toBeGreaterThan(1000);
    expect(src).toContain("function typeOf");
  });

  it("exposes a non-defaulting accessor for the declared category", () => {
    expect(
      /function declaredCategoryOf\([\s\S]{0,200}?entry\.category \?\? null/.test(src),
      "declaredCategoryOf must return null — not a default — when the catalog " +
        "declared no category. Without it there is no way to tell 'workspace' " +
        "from 'unknown'."
    ).toBe(true);
  });

  it("the install path uses the non-defaulting accessor, not typeOf", () => {
    // `let`, because the install path may still try the AUTHED single-package
    // door before giving up (a private package the caller owns) — what it may
    // never do is fall back to `typeOf`'s "workspace".
    const start = src.search(/\b(?:const|let) declared = declaredCategoryOf\(entry\)/);
    expect(
      start,
      "the install path no longer calls declaredCategoryOf — it will fall back " +
        "to typeOf's `?? \"workspace\"` and provision a spurious workspace for " +
        "any package it cannot classify."
    ).toBeGreaterThan(0);
    // …and it must REFUSE on null rather than carrying on.
    const window = src.slice(start, start + 1200);
    expect(window).toContain("process.exit(1)");
    expect(window, "the refusal window must not default the category").not.toContain(
      'declaredCategoryOf(entry) ?? "workspace"'
    );
  });

  /**
   * `--dry-run` promised "writes nothing" and, for five of the six kinds,
   * performed the install anyway.
   *
   * Found 2026-09-05 while dogfooding the fix above. The dry-run branch lives
   * on the WORKSPACE path (it needs `/packages/preflight`, which only that door
   * has). But the capability branch returns to `capabilityAdd` earlier, and the
   * generic `market.install` branch earlier still — neither read the flag. The
   * pod verb has no `dryRun` parameter (`marketInstallParams`), so there is
   * nothing to forward: the only honest option is to refuse.
   *
   * A safety flag that performs the action it promises to skip is worse than no
   * flag at all, because it is used precisely when the user is being careful.
   */
  it("--dry-run refuses for non-workspace kinds instead of silently installing", () => {
    const guard = src.search(/if \(opts\.dryRun && type !== "workspace"\)/);
    expect(
      guard,
      "the non-workspace --dry-run guard is gone: `synap market install " +
        "<capability> --dry-run` will install for real, because neither the " +
        "capability branch nor the market.install branch reads opts.dryRun."
    ).toBeGreaterThan(0);

    // It must come BEFORE the capability branch, which returns early.
    const capBranch = src.search(/if \(type === "capability"\)/);
    expect(capBranch).toBeGreaterThan(0);
    expect(
      guard,
      "the guard sits AFTER the capability branch returns, so it can never run " +
        "for a capability — the exact kind that motivated it."
    ).toBeLessThan(capBranch);

    // …and it must actually stop, not merely warn.
    expect(src.slice(guard, guard + 500)).toContain("process.exit(1)");
  });
});
