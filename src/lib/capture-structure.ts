/**
 * Shared shapes + honest reporting for the smart-capture pipeline
 * (POST /capture/structure → POST /capture/execute).
 *
 * ONE declaration of the structure/execute wire shapes and ONE degraded/execute
 * interpreter, imported by BOTH surfaces that drive this pipeline:
 *   • `synap capture "<free text>"`  (commands/knowledge.ts)
 *   • `synap import <files|urls>`    (commands/import.ts)
 *
 * These two used to keep independent `StructureResult` copies that had already
 * drifted (import dropped fields knowledge kept). Consolidating here removes the
 * drift AND the false-success reporting: the CLI now reports what /capture/execute
 * ACTUALLY returned (applied vs proposed vs nothing-created) instead of guessing
 * off the planned proposal count.
 *
 * Kept local to the CLI (not imported from @synap/hub-rest-client) because the
 * CLI resolves the SDK via its built dist — the same reason the previous local
 * mirrors existed. This is now the ONE mirror instead of two.
 */

export interface StructureProposal {
  tempId: string;
  profileSlug: string;
  title: string;
  description?: string;
  properties?: Record<string, unknown>;
  content?: string;
  existingEntityId?: string;
}

export interface StructureRelation {
  sourceTempId: string;
  targetTempId: string;
  relationType: string;
}

// Mirrors @synap/hub-rest-client's StructuredFollowUp/FollowUpChip. The chip is
// an OBJECT, not a string — a `string[]` here rendered chips as "[object Object]".
export interface FollowUpChip {
  label: string;
  value: string;
  action?: "link_entity" | "set_property" | "add_relation" | "confirm" | "dismiss";
  entityId?: string;
  propertyKey?: string;
}

export interface FollowUp {
  question: string;
  suggestions?: FollowUpChip[];
}

/** Response of POST /capture/structure (the AI plan — writes NOTHING). */
export interface StructureResult {
  proposals?: StructureProposal[];
  relations?: StructureRelation[];
  // May be a plain string OR a structured { question, suggestions[] } object.
  followUp?: string | FollowUp | null;
  targetWorkspaceId?: string | null;
  targetWorkspaceConfidence?: number | null;
  targetWorkspaceReason?: string | null;
  targetProjectId?: string | null;
  targetProjectConfidence?: number | null;
  targetProjectReason?: string | null;
  /** True when the IS structurer is down and the server returned a raw fallback. */
  degraded?: boolean;
  degradedReason?: string;
}

/** One materialized entity row in a /capture/execute response. */
export interface ExecuteCreated {
  tempId?: string;
  entityId?: string;
  id?: string;
  profileSlug?: string;
  /** true = linked/deduped onto an EXISTING entity (nothing new was created). */
  linked?: boolean;
  degradedFrom?: string;
  propertiesDropped?: boolean;
  deduplicated?: boolean;
}

/**
 * Response of POST /capture/execute — either a governed proposal (nothing
 * written) or a materialized graph. The CLI authenticates as an agent, so it
 * usually materializes, but a workspace policy can still queue a proposal; the
 * reporter below reflects whichever actually happened.
 *
 * NOTE: there is no top-level `entitiesCreated`/`relationsCreated` on this
 * response — those live only in the server's log line. Counts MUST be derived
 * from `created`/`relations` (see `readCaptureExecute`).
 */
export interface ExecuteResult {
  /** "proposed" when governance queued the write instead of applying it. */
  status?: string;
  created?: ExecuteCreated[];
  relations?: unknown[];
  proposalId?: string;
  reviewUrl?: string;
  reviewPath?: string;
  movedToWorkspace?: string | null;
  message?: string;
}

/** The honest outcome of a /capture/execute call, derived from the response. */
export interface CaptureExecuteOutcome {
  /** true when the write was queued for review, NOT applied. */
  proposed: boolean;
  /** entities newly created (excludes rows linked/deduped onto existing ones). */
  entitiesCreated: number;
  /** entities linked/deduped onto existing entities (nothing new stored). */
  entitiesLinked: number;
  relationsCreated: number;
  proposalId?: string;
  reviewUrl?: string;
  movedToWorkspace?: string;
}

/**
 * Interpret a /capture/execute response HONESTLY. Distinguishes applied vs
 * proposed vs nothing-created and surfaces the real proposal/review handle so
 * the CLI never claims "created" for a write that was proposed or a plan that
 * only linked existing entities.
 */
export function readCaptureExecute(res: ExecuteResult): CaptureExecuteOutcome {
  const created = Array.isArray(res.created) ? res.created : [];
  const proposed = res.status === "proposed" || Boolean(res.proposalId);
  return {
    proposed,
    entitiesCreated: created.filter((c) => !c.linked).length,
    entitiesLinked: created.filter((c) => c.linked).length,
    relationsCreated: Array.isArray(res.relations) ? res.relations.length : 0,
    proposalId: res.proposalId ? String(res.proposalId) : undefined,
    reviewUrl: res.reviewUrl ? String(res.reviewUrl) : undefined,
    movedToWorkspace: res.movedToWorkspace
      ? String(res.movedToWorkspace)
      : undefined,
  };
}

/** True when the structure step degraded (IS structurer unavailable). */
export function isDegraded(res: StructureResult): boolean {
  return res.degraded === true;
}

/**
 * The ONE degraded message. When the structurer is down the server returns a
 * generic `item` stand-in wrapping the raw text — but the CLI does NOT
 * materialize it (the browser does the same via `offlineFallback:false`). We
 * create nothing and tell the user, so a captured note is never silently
 * downgraded to an unstructured blob behind a "success" line. Retry when the
 * structurer is back.
 */
export function degradedMessage(res: StructureResult): string {
  const why = res.degradedReason ? ` (${res.degradedReason})` : "";
  return `AI structuring unavailable${why} — nothing was created. Retry when it's back.`;
}
