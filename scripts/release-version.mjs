#!/usr/bin/env node
/**
 * The version a CLI release carries, derived in the publish job and never
 * committed by it, on either channel (`.github/workflows/publish-cli.yml`).
 * main is protected (ruleset "main: PR only", 2 Nov 2026): the job cannot
 * push a bump there, so the registry, not `package.json`, carries the number.
 *
 *   next   → `<next patch>-next.<YYYYMMDD>.<sha7>`, published under the npm
 *            dist-tag `next` on every merge to main. The base is the HIGHER of
 *            `package.json` and the registry's `latest`: on 2026-10-27 1.13.0
 *            was published by hand from a laptop while main still said 1.12.2,
 *            so a base read from `package.json` alone would have produced a
 *            `1.12.3-next…` that sorts BELOW the release users already have.
 *   latest → `<next patch>`, published under `latest` by a dispatch. Same
 *            base as `next`: the HIGHER of `package.json` and the registry's
 *            `latest`, so a release never repeats or lowers a number.
 *   ahead  → the `latest` path's guard: the version the job just wrote must
 *            be above the registry's `latest`, or the run stops before
 *            anything is tagged or published (npm moves `latest` to whatever
 *            is published under it, even a LOWER version).
 *
 * Usage:
 *   node scripts/release-version.mjs next   --latest <v> --sha <git sha> [--date YYYYMMDD]
 *   node scripts/release-version.mjs latest --latest <v>
 *   node scripts/release-version.mjs ahead  --latest <v>
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** `1.2.3` (any prerelease or build suffix ignored) → [1, 2, 3]. */
export function parseCore(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(version).trim());
  if (!m) throw new Error(`not a semver version: "${version}"`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Compare two release cores: negative, zero or positive. */
export function compareCore(a, b) {
  const [x, y] = [parseCore(a), parseCore(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/**
 * The prerelease a merge publishes under `next`. The sha identifier is
 * prefixed with `g` (as `git describe` does) only when it is all digits: a
 * numeric semver identifier may not start with 0, so `0123456` would make the
 * whole version invalid.
 */
export function nextPrerelease({ base, latest, sha, date }) {
  const [major, minor, patch] = parseCore(higher(base, latest));
  const sha7 = String(sha).trim().slice(0, 7).toLowerCase();
  if (!/^[0-9a-f]{7}$/.test(sha7)) throw new Error(`not a git sha: "${sha}"`);
  if (!/^\d{8}$/.test(String(date))) throw new Error(`not a YYYYMMDD date: "${date}"`);
  const shaId = /^\d+$/.test(sha7) ? `g${sha7}` : sha7;
  return `${major}.${minor}.${patch + 1}-next.${date}.${shaId}`;
}

/** The higher of `package.json`'s version and npm's `latest` (none: the base). */
function higher(base, latest) {
  return latest && compareCore(latest, base) > 0 ? latest : base;
}

/**
 * The release a dispatch publishes under `latest`: the next patch of the
 * higher of `package.json` and npm's `latest`. Derived, never committed.
 */
export function nextRelease({ base, latest }) {
  const [major, minor, patch] = parseCore(higher(base, latest));
  return `${major}.${minor}.${patch + 1}`;
}

/** Throws unless `candidate` is a release strictly above `latest`. */
export function assertAhead(candidate, latest) {
  if (latest && compareCore(candidate, latest) <= 0) {
    throw new Error(
      `package.json would publish ${candidate}, but npm's latest is already ${latest}: ` +
        `npm would move \`latest\` BACK to ${candidate}. Set package.json on main to at least ${latest}, then release again.`
    );
  }
}

function utcDate(now = new Date()) {
  return now.toISOString().slice(0, 10).replace(/-/g, "");
}

function arg(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main(argv) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const latest = arg(argv, "latest") || undefined;
  const mode = argv[0];
  if (mode === "next") {
    process.stdout.write(
      nextPrerelease({ base: version, latest, sha: arg(argv, "sha"), date: arg(argv, "date") ?? utcDate() }) + "\n"
    );
  } else if (mode === "latest") {
    process.stdout.write(nextRelease({ base: version, latest }) + "\n");
  } else if (mode === "ahead") {
    assertAhead(version, latest);
    process.stdout.write(`${version} is ahead of npm latest ${latest ?? "(none)"}\n`);
  } else {
    throw new Error("usage: release-version.mjs next|latest|ahead --latest <v> [--sha <sha>] [--date YYYYMMDD]");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`release-version: ${err.message}\n`);
    process.exit(1);
  }
}
