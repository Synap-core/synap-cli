/**
 * Suite detection — data-driven, not a hardcoded slug allowlist.
 * =============================================================
 *
 * A SUITE is a headline package that installs a whole operating core by
 * composing/requiring several constituent workspaces (e.g. `enterprise-os`,
 * `the-arch`). It is authored in the template YAML's `meta.tags` and mirrored
 * onto every catalog surface, so "is this a suite?" is a first-class signal
 * rather than the `COMPANY_SUITE` / `PRIVATE_SUITE` slug constants the CLI used
 * to hand-maintain.
 *
 * This is a MIRROR, not a second source of truth. The SSOT is
 * `@synap-core/marketplace` (`SUITE_TAG` / `isSuite` in `src/types.ts`). That
 * package is a React feature package with no build output and a barrel that
 * drags in `react` / JSX, so a Node CLI compiled with `tsc` cannot import it
 * without breaking its build. The value is a single string — mirrored here the
 * same way `marketplace/types.ts` itself mirrors the CP's schema vocabulary.
 */

/** The tag that marks a package as a suite. SSOT: `@synap-core/marketplace`. */
export const SUITE_TAG = "suite" as const;

/**
 * A suite is identified by the presence of `SUITE_TAG` in its tags. Works on any
 * catalog shape carrying tags — a bundled `CatalogEntry`, a `RemoteEntry`, or a
 * raw `{ tags }` projection.
 */
export function isSuite(entry: { tags?: readonly string[] | null }): boolean {
  return entry.tags?.includes(SUITE_TAG) ?? false;
}
