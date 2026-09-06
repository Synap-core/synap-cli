/**
 * What `--from-workspace` does NOT carry out of a live workspace.
 * =================================================================
 *
 * `synap market publish --from-workspace <id>` serialises a LIVE workspace
 * through the pod's `workspaceToPackageDefinition`
 * (synap-backend/packages/api/src/services/workspace-to-package-definition.ts)
 * and posts the result. That serialiser is a **lossy projection**: it emits 20
 * of `packageDefinitionSchema`'s keys and has no projection at all for the ones
 * below. A workspace carrying them exports WITHOUT them — no error, no signal.
 *
 * `TEMPLATE-DEV-GUIDE.md` used to assert, unqualified, that a
 * `PackageDefinition` "round-trips". It does not, in this direction, and the
 * consequence is the shape this repo keeps paying for: an author who built
 * Cards in Card Studio publishes their workspace, ships a gutted package, and
 * gets a success message. Same class as `status ?? "installed"` — a claim of
 * completeness nobody verified.
 *
 * ── WHY THIS LIST IS UNCONDITIONAL, NOT DETECTED ────────────────────────────
 * The CLI never sees the workspace, only the projection's OUTPUT. "key absent
 * because the workspace had none" and "key absent because the serialiser cannot
 * emit it" are indistinguishable from here, and reporting a count would be
 * inventing a fact. So this warns about the DOOR ("this door does not carry
 * these"), which is true on every call, rather than about the payload.
 *
 * Keeping it honest across the repo boundary is
 * `test/exporter-coverage-parity.test.ts`, which reads the exporter's own
 * source and fails if a key listed here has gained an assignment (the list is
 * stale and over-warns) or if a key it claims to emit has lost one.
 */

/** A `packageDefinitionSchema` key the workspace serialiser cannot emit. */
export interface UnemittedKey {
  /** The `PackageDefinition` key, verbatim. */
  key: string;
  /** What an author actually loses, in product words (Card, not cell). */
  loses: string;
}

/**
 * Keys with real user-authored content behind them that the serialiser drops.
 *
 * DELIBERATELY EXCLUDED, and why — these are absent from the export too, but
 * warning about them would be noise rather than a loss:
 *   • `icon` / `color` / `domain` / `workspaceType` — a live workspace has no
 *     field to read them from (the exporter says so at L107-109). Honest
 *     under-convergence, not a silent drop.
 *   • `suggestedEntities` / `suggestedRelations` / `phases` / `composesFrom` —
 *     authoring-time seed hints and composition metadata. A live workspace has
 *     real entities, not "suggestions"; there is nothing to derive them from.
 *   • `capability` / `sourcePackage` / `contentHash` — a non-workspace package
 *     body and publish-time provenance. Not this door's business.
 */
export const EXPORTER_UNEMITTED_KEYS: readonly UnemittedKey[] = [
  { key: "cells", loses: "Cards — everything authored in Card Studio" },
  { key: "commands", loses: "workspace commands" },
  { key: "relationDefs", loses: "relation definitions" },
  { key: "loops", loses: "loops" },
  { key: "widgets", loses: "widget definitions" },
  { key: "dependencies", loses: "declared package dependencies" },
  { key: "defaultSources", loses: "declared workspace sources" },
  { key: "sourceRoles", loses: "source roles" },
];

/**
 * The keys the serialiser DOES emit. Not consumed at runtime — it is the other
 * half of the parity tripwire's assertion, so that "emits" and "does not emit"
 * are pinned by the same read of the same source and cannot disagree.
 */
export const EXPORTER_EMITTED_KEYS: readonly string[] = [
  "_meta",
  "workspaceName",
  "description",
  "workspaceSubtype",
  "workspaceVisibility",
  "workspaceCapabilities",
  "onboarding",
  "profileEntityBentoTemplates",
  "profiles",
  "bentoLayout",
  "bentoViewBlocks",
  "bentoViewName",
  "views",
  "entityLinks",
  "displayTemplates",
  "automations",
  "playbooks",
  "capabilities",
  "layoutConfig",
  "actionPlacements",
];

/**
 * One human line per dropped key, for `--json`'s `warnings[]` and for the
 * terminal hint list. Deliberately phrased as a property of the DOOR.
 */
export function exporterDropWarnings(): string[] {
  return EXPORTER_UNEMITTED_KEYS.map(
    (k) => `${k.key} — ${k.loses} (not exported: no projection)`,
  );
}
