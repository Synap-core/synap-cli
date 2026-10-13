/**
 * The per-kind wire envelopes and the ONE unwrap — import-free on purpose.
 *
 * Re-exported (with the workspace types) by `./wire`, the public subpath
 * `@synap-core/workspace-templates/wire`. It has no imports so a consumer that
 * still resolves an older npm copy of this package (the CLI, the CP, the pod)
 * can carry it as a BYTE-IDENTICAL mirror pinned by a tripwire until it can
 * import the subpath. Edit it here; the mirror copies it.
 *
 * What `GET {CP}/api/packages/:slug` serves as `package.definition`, per kind:
 * the outputs of this package's producers (`scripts/catalog-lib.mjs`
 * `toPublishBody`; `toOfficialPublishBody` for workspaces) plus what the CP
 * adds on store/serve (`_meta.slug` via `withTemplateSlug`,
 * `capability.contentHash`).
 *
 * WHY: a skill package is served as `{ _meta, skill: {…} }`. Read flat, every
 * field is `undefined`: install refused a "bodiless" skill and the update door
 * reported "no drift" forever (founder pod 2026-10-13, creative-director). Each
 * consumer had its own cast; this is the one place the envelope is known.
 *
 * Element fields are pinned to the catalog schema (`SKILL_FIELDS`,
 * `CapabilitySpec`) and `AutomationElement` to `PackageAutomationWire` by
 * `schema/wire.parity.test.ts` (compile time).
 */

// ─── Kinds ──────────────────────────────────────────────────────────────────

/** The kinds whose served definition this module describes. */
export const WIRE_KINDS = ["workspace", "capability", "skill", "automation", "view"] as const;
export type WireKind = (typeof WIRE_KINDS)[number];

/**
 * Other names the same kinds go by: the pod's `market.install` says
 * `template`, the CP category for an automation is `workflow`, and a pack is
 * a workspace-shaped definition.
 */
export const WIRE_KIND_ALIASES = {
  template: "workspace",
  pack: "workspace",
  workflow: "automation",
} as const satisfies Record<string, WireKind>;
export type WireKindName = WireKind | keyof typeof WIRE_KIND_ALIASES;

/** `template` → `workspace`, `workflow` → `automation`; `null` for a kind with no wire contract here (e.g. `cell`). */
export function toWireKind(kind: string): WireKind | null {
  if ((WIRE_KINDS as readonly string[]).includes(kind)) return kind as WireKind;
  return (WIRE_KIND_ALIASES as Record<string, WireKind>)[kind] ?? null;
}

// ─── Envelope pieces every kind shares ──────────────────────────────────────

/**
 * `definition._meta` as served: the CP stamps `slug` on every row (the pod
 * keys "which space is this template's?" on it); the CLI adds the `version`
 * label it installs.
 */
export interface WireMeta {
  slug?: string;
  version?: string;
  [key: string]: unknown;
}

/** `meta.icon` / `color` / `domain`, mirrored onto the definition by every publish builder. */
export interface WireIdentity {
  icon?: string;
  color?: string;
  domain?: string;
}

/** A composition dependency. */
export interface WireDependency {
  slug: string;
  kind?: "workspace" | "capability" | "skill" | "workflow" | "view" | "cell" | "automation";
  relation?: "compose" | "require";
  reason?: string;
}

export interface WireEnvelope extends WireIdentity {
  _meta?: WireMeta;
  dependencies?: WireDependency[];
}

// ─── Elements and envelopes, per kind ───────────────────────────────────────

/** The capability itself (`CapabilityDefinition`). */
export interface CapabilityElement {
  key: string;
  name: string;
  description?: string;
  params?: Array<Record<string, unknown>>;
  vault?: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  skills?: Array<Record<string, unknown>>;
  provides?: string[];
  playbooks?: Array<Record<string, unknown>>;
  /** Stamped by the CP on publish; the pod's drift marker. */
  contentHash?: string;
  automations?: Array<Record<string, unknown>>;
  mcpServers?: unknown;
  metadata?: Record<string, unknown>;
  _generated?: unknown;
}

/** capability: `{ profiles: [], description, capability }`. */
export interface CapabilityWire extends WireEnvelope {
  profiles: unknown[];
  description?: string;
  capability: CapabilityElement;
}

/** ONE standalone skill. Not a workspace's `skills[]` link list. */
export interface SkillElement {
  /** The pod-side `load_skill` ref — its own identity, not the package slug. */
  slug?: string;
  name?: string;
  displayName?: string;
  description?: string;
  kind?: "instruction" | "code" | "declarative" | "builtin";
  scope?: "pod" | "user" | "workspace";
  agentTypes?: string[];
  body?: string;
  code?: string;
  providerSpec?: Record<string, unknown>;
  parameters?: Record<string, unknown>;
  category?: string;
  executionMode?: "sync" | "async";
  timeoutSeconds?: number;
  intent?: string;
  [key: string]: unknown;
}

/** skill: `{ skill, icon?, color?, domain?, dependencies? }`. */
export interface SkillWire extends WireEnvelope {
  skill: SkillElement;
}

/** One graph automation (= `PackageAutomationWire`): `flowDefinition`, not the authored `flow`. */
export interface AutomationElement {
  key?: string;
  name: string;
  description?: string;
  triggerType: "event" | "cron" | "webhook" | "manual";
  triggerConfig?: Record<string, unknown>;
  flowDefinition?: { nodes: unknown[]; edges: unknown[]; precondition?: string };
  status?: "draft" | "active" | "paused";
}

/** automation (CP category `workflow`): `{ profiles: [], automations: [one] }`. */
export interface AutomationWire extends WireEnvelope {
  profiles: unknown[];
  automations: AutomationElement[];
}

/** One view, as the pod's view install and update doors read it. */
export interface ViewElement {
  slug?: string;
  name?: string;
  displayName?: string;
  description?: string;
  type?: string;
  config?: Record<string, unknown>;
  query?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  scopeProfileSlugs?: string[];
  scopeProfileIds?: string[];
  [key: string]: unknown;
}

/** view: `{ views: [...] }`, or a legacy single view with its fields on top (has its own `type`). No catalog producer today. */
export type ViewWire = (WireEnvelope & { views: ViewElement[] }) | ViewElement;

/**
 * What {@link unwrapPackage} returns per kind. `workspace` is the definition
 * itself; `./wire` narrows it to `WorkspaceWire`.
 */
export interface PackageElementByKind<W = Record<string, unknown>> {
  workspace: W;
  capability: CapabilityElement;
  skill: SkillElement;
  automation: AutomationElement[];
  view: ViewElement[];
}

export type ElementOf<K extends WireKindName, W = Record<string, unknown>> = PackageElementByKind<W>[K extends WireKind
  ? K
  : K extends keyof typeof WIRE_KIND_ALIASES
    ? (typeof WIRE_KIND_ALIASES)[K]
    : never];

// ─── The ONE unwrap ─────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The installable element(s) inside a served definition:
 *
 *   skill      → the `skill` object (a legacy flat definition is the skill itself)
 *   capability → the `capability` object (a flat `CapabilityDefinition` — the
 *                pod cache / CP by-key shape — passes through)
 *   automation → `automations[]` (`[]` when the definition declares none)
 *   view       → `views[]`, or a legacy flat view (top-level `type`) as `[def]`, else `[]`
 *   workspace  → the definition itself
 *
 * An empty array means the definition declares none; the install doors refuse
 * that themselves. A definition that is not an object is a failed read, never
 * an empty one: it throws.
 */
export function unwrapPackage<K extends WireKindName>(kind: K, definition: unknown): ElementOf<K>;
export function unwrapPackage(kind: string, definition: unknown): unknown {
  const wireKind = toWireKind(kind);
  if (!wireKind) throw new Error(`unwrapPackage: "${kind}" has no wire contract`);
  if (!isRecord(definition)) {
    throw new TypeError(
      `unwrapPackage(${kind}): the definition is not an object (${definition === null ? "null" : Array.isArray(definition) ? "array" : typeof definition})`,
    );
  }
  switch (wireKind) {
    case "skill":
      return isRecord(definition.skill) ? definition.skill : definition;
    case "capability":
      return isRecord(definition.capability) ? definition.capability : definition;
    case "automation":
      return Array.isArray(definition.automations) ? definition.automations : [];
    case "view":
      if (Array.isArray(definition.views) && definition.views.length > 0) return definition.views;
      return definition.type ? [definition] : [];
    case "workspace":
      return definition;
  }
}
