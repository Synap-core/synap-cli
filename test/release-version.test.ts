/**
 * The CLI's two release channels (`.github/workflows/publish-cli.yml`):
 * `next` on every merge to main, `latest` by hand. These rows pin the version
 * each one derives, and that the workflow wires them so a merge can never move
 * `latest` and no run ever commits to main (main is protected: ruleset "main:
 * PR only, no deletion or force push", bypass OrganizationAdmin only).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { assertAhead, nextPrerelease, nextRelease } from "../scripts/release-version.mjs";

const root = path.join(__dirname, "..");

describe("nextPrerelease", () => {
  it("is the next patch of package.json, dated and named by the commit", () => {
    expect(nextPrerelease({ base: "1.13.0", latest: "1.13.0", sha: "02ae1b939b423b38", date: "20261102" })).toBe(
      "1.13.1-next.20261102.02ae1b9"
    );
  });

  it("starts from npm's latest when a hand publish put it above package.json", () => {
    // 2026-10-27: npm latest 1.13.0, main's package.json 1.12.2.
    expect(nextPrerelease({ base: "1.12.2", latest: "1.13.0", sha: "abcdef1234", date: "20261102" })).toBe(
      "1.13.1-next.20261102.abcdef1"
    );
  });

  it("keeps a valid semver when the short sha is all digits with a leading zero", () => {
    expect(nextPrerelease({ base: "1.13.0", latest: undefined, sha: "0123456789", date: "20261102" })).toBe(
      "1.13.1-next.20261102.g0123456"
    );
  });
});

describe("nextRelease (the latest path)", () => {
  it("is the next patch of package.json when npm's latest is not above it", () => {
    expect(nextRelease({ base: "1.13.0", latest: "1.13.0" })).toBe("1.13.1");
    expect(nextRelease({ base: "1.13.0", latest: undefined })).toBe("1.13.1");
  });

  it("starts from npm's latest when main's package.json lags (it is never bumped on main)", () => {
    expect(nextRelease({ base: "1.13.0", latest: "1.13.4" })).toBe("1.13.5");
    expect(() => assertAhead(nextRelease({ base: "1.12.2", latest: "1.13.0" }), "1.13.0")).not.toThrow();
  });
});

describe("assertAhead (the latest path)", () => {
  it("refuses a version that would move npm's latest backwards", () => {
    expect(() => assertAhead("1.12.3", "1.13.0")).toThrow(/move `latest` BACK/);
    expect(() => assertAhead("1.13.0", "1.13.0")).toThrow();
  });

  it("accepts the next release", () => {
    expect(() => assertAhead("1.13.1", "1.13.0")).not.toThrow();
  });
});

describe("main's package.json", () => {
  it("is not behind npm's latest of 2026-10-27 (1.13.0, published by hand)", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    expect(() => assertAhead("1.13.1", pkg.version)).not.toThrow();
    expect(nextPrerelease({ base: pkg.version, latest: "1.13.0", sha: "abcdef1", date: "20261102" })).toMatch(
      /^1\.13\.1-next\./
    );
    expect(pkg.version).toBe("1.13.0");
  });
});

describe("publish-cli.yml", () => {
  const wf = YAML.parse(fs.readFileSync(path.join(root, ".github/workflows/publish-cli.yml"), "utf8"));
  const steps: Array<{ name?: string; if?: string; run?: string }> = wf.jobs.publish.steps;
  const step = (re: RegExp) => {
    const s = steps.find((x) => re.test(x.name ?? ""));
    if (!s) throw new Error(`no step matching ${re}`);
    return s;
  };

  it("runs on a push to main as well as by hand", () => {
    expect(wf.on.push.branches).toEqual(["main"]);
    expect(wf.on).toHaveProperty("workflow_dispatch");
  });

  it("no step commits, and the only push is a dispatch's release tag", () => {
    for (const s of steps) expect(s.run ?? "").not.toMatch(/git commit|npm version patch/);
    const pushes = steps.filter((x) => /git push/.test(x.run ?? ""));
    expect(pushes.map((x) => x.name)).toEqual(["Tag the release"]);
    expect(pushes[0].if).toBe("github.event_name == 'workflow_dispatch'");
    expect(pushes[0].run).toMatch(/git push origin "refs\/tags\/v\$VERSION"/);
  });

  it("a dispatch derives its version from npm's latest and tags it only after publishing", () => {
    const derive = step(/^Set the latest version/);
    expect(derive.if).toBe("github.event_name == 'workflow_dispatch'");
    expect(derive.run).toMatch(/release-version\.mjs latest --latest "\$LATEST"/);
    const names = steps.map((x) => x.name ?? "");
    expect(names.indexOf("Tag the release")).toBeGreaterThan(names.findIndex((n) => /^Publish to npm/.test(n)));
  });

  it("a push publishes under the next dist-tag, never latest", () => {
    const publish = step(/^Publish to npm/);
    expect(publish.run).toMatch(/--tag "\$CHANNEL"/);
    expect(String(wf.jobs.publish.env.CHANNEL)).toMatch(
      /github\.event_name == 'workflow_dispatch' && 'latest' \|\| 'next'/
    );
  });

  it("a push runs in npm-next, a dispatch from main waits for the production reviewer", () => {
    const env = String(wf.jobs.publish.environment);
    expect(env).toMatch(/github\.event_name == 'push' && 'npm-next'/);
    expect(env).toMatch(/github\.ref == 'refs\/heads\/main' && 'production'/);
  });

  it("a push derives its version from the commit it checked out, and never commits it", () => {
    const derive = step(/^Set the next version/);
    expect(derive.if).toBe("github.event_name == 'push'");
    expect(derive.run).toMatch(/release-version\.mjs next --latest "\$LATEST" --sha "\$GITHUB_SHA"/);
    expect(derive.run).not.toMatch(/git (commit|push)/);
    const checkout = steps.find((x) => x.name === "Checkout synap-cli") as { with: { ref: string } };
    expect(checkout.with.ref).toBe("${{ github.sha }}");
  });

  it("a dispatch checks the version is ahead of npm's latest before it publishes", () => {
    const names = steps.map((x) => x.name ?? "");
    const guard = names.findIndex((n) => /ahead of npm's latest/.test(n));
    const publish = names.findIndex((n) => /^Publish to npm/.test(n));
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(publish);
    expect(steps[guard].run).toMatch(/release-version\.mjs ahead/);
  });
});
