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
  degradedReason?: DegradedReason;
  /**
   * Summary of the extraction pass, present when a `file` input was normalized
   * to text before structuring. `text` is what the pod needs echoed back on
   * execute (as `file.extractedText`) so a kept original lands with a real
   * document body instead of an empty one — the pod cannot re-derive it,
   * because extraction runs in the Intelligence Service.
   */
  extraction?: {
    kind: string;
    extractor: string;
    metadata?: Record<string, unknown>;
    warnings?: string[];
    text?: string;
    textTruncated?: boolean;
  };
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
  /**
   * Disposition of the ORIGINAL file, present only when the caller sent
   * `keepRaw: true` + `file`. Four honest outcomes — the blob can be stored,
   * parked behind governance, denied by policy, or fail on storage — and a
   * caller that prints "kept" for all four is back to false success.
   */
  sourceFile?: {
    status: "stored" | "proposed" | "denied" | "failed";
    entityId?: string;
    documentId?: string;
    proposalId?: string;
    reviewUrl?: string;
    reason?: string;
  };
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

/** True when the structure step degraded (nothing usable came back). */
export function isDegraded(res: StructureResult): boolean {
  return res.degraded === true;
}

/**
 * WHY a capture degraded. Two families, and the difference is the whole point:
 *
 *  • pod plumbing (`is_*`) — the structurer itself failed. Retrying is sensible.
 *  • Intelligence Service extraction honesty (everything else) — the INPUT
 *    could not be read. Several of these are PERMANENT CONFIGURATION states
 *    (`vision_provider_not_configured`, `transcription_provider_not_configured`)
 *    where "retry when it's back" is simply a lie: nothing is coming back.
 *
 * Open-ended (`string & {}`) because the IS owns this vocabulary and may add to
 * it. An unknown value must humanize, never leak, never crash.
 */
export type DegradedReason =
  | "is_auth_error"
  | "is_invalid_response"
  | "is_empty_result"
  | "pdf_scanned_needs_ocr"
  | "pdf_missing_binary"
  | "vision_provider_not_configured"
  | "image_missing_binary"
  | "transcription_provider_not_configured"
  | "audio_missing_binary"
  | "docx_missing_binary"
  | "docx_empty"
  | "html_empty"
  | "unsupported_type"
  | (string & {});

/**
 * One line of honest copy for a degraded reason: WHAT happened, and WHAT TO DO.
 *
 * ── Why this is a second table, deliberately ────────────────────────────────
 * `@synap-core/capture-pipeline`'s `describeDegradedReason` is the existing
 * one-door for this copy, and it is the RIGHT door — but the CLI is a separate
 * pnpm workspace whose only Synap runtime dependencies are
 * `@synap/hub-rest-client` (a file: link into synap-backend) and
 * `@synap-core/workspace-templates`. It cannot reach a `synap-app` package
 * without a package.json/lockfile change. Same reason the `StructureResult`
 * mirror above is local.
 *
 * So: the `title` half is COPIED VERBATIM from `describeDegradedReason` and
 * pinned by a parity test (`test/degraded-message-honesty.test.ts`) that reads
 * the sibling repo's source, so the two can never drift on WHAT happened.
 * The `detail` half is deliberately DIFFERENT, because the app's
 * details end in "saved as a note in the meantime" and the CLI creates nothing
 * at all — repeating the app's sentence here would be a new lie in place of the
 * old one.
 */
export function describeDegradedReason(reason: DegradedReason | undefined): {
  title: string;
  detail: string;
} {
  switch (reason) {
    case "is_auth_error":
      return {
        title: "AI intelligence isn't connected",
        detail:
          "This pod's Intelligence Service rejected its credentials. Check them with `synap doctor`, then re-run this import.",
      };
    case "pdf_scanned_needs_ocr":
      return {
        title: "This PDF has no text layer",
        detail:
          "It's a scan, not typed text, so there is nothing to read yet. OCR it first, or keep the original with `synap import --keep-raw <file>`.",
      };
    case "pdf_missing_binary":
      return {
        title: "The PDF file wasn't available to read",
        detail: "The bytes never reached the pod. Re-run the import for this file.",
      };
    case "vision_provider_not_configured":
      return {
        title: "Image reading isn't set up on this pod",
        detail:
          "No vision-capable model is configured, so images can't be described. Configure one in Settings → Intelligence; until then keep the original with `synap import --keep-raw <file>`.",
      };
    case "image_missing_binary":
      return {
        title: "The image file wasn't available to read",
        detail: "The bytes never reached the pod. Re-run the import for this file.",
      };
    case "transcription_provider_not_configured":
      return {
        title: "Audio transcription isn't set up on this pod",
        detail:
          "No transcription model is configured, so speech can't be turned into text. Configure one in Settings → Intelligence; until then keep the original with `synap import --keep-raw <file>`.",
      };
    case "audio_missing_binary":
      return {
        title: "The audio file wasn't available to read",
        detail: "The bytes never reached the pod. Re-run the import for this file.",
      };
    case "docx_missing_binary":
      return {
        title: "The document file wasn't available to read",
        detail: "The bytes never reached the pod. Re-run the import for this file.",
      };
    case "docx_empty":
      return {
        title: "This document has no extractable text",
        detail:
          "It parsed cleanly but came back empty. Keep the original with `synap import --keep-raw <file>` if you still want it stored.",
      };
    case "html_empty":
      return {
        title: "This page has no extractable text",
        detail:
          "It parsed cleanly but came back empty — often a JavaScript-rendered page. Save the readable text yourself and pass it to `synap capture`.",
      };
    case "unsupported_type":
      return {
        title: "This file type isn't supported yet",
        detail:
          "Nothing can be extracted from it. Keep the bytes anyway with `synap import --keep-raw <file>`, or `synap upload <file>` to store it as a file entity.",
      };
    case "is_invalid_response":
    case "is_empty_result":
    case undefined:
      return {
        title: "AI structuring is unavailable right now",
        detail: "Nothing was created. Re-run this import when the structurer is back.",
      };
    default:
      // A reason this list hasn't been taught yet (the IS added one, and the
      // wire type is an open string). Degrade gracefully — never print the raw
      // token at a user, and never crash on it.
      return {
        title: "This input couldn't be read",
        detail: "Nothing was created. Run `synap doctor` to check what this pod can extract.",
      };
  }
}

/**
 * The ONE degraded message. The CLI does NOT materialize the server's generic
 * `item` stand-in (the browser does the same via `offlineFallback:false`), so a
 * captured note is never silently downgraded to an unstructured blob behind a
 * "success" line.
 *
 * It used to print a single sentence for every cause — "AI structuring
 * unavailable (is_empty_result) — nothing was created. Retry when it's back."
 * — which leaked a raw machine token AND told users to retry states that never
 * change (a pod with no vision provider is not going to come back). Now each
 * reason says what actually happened and what to do about it.
 */
export function degradedMessage(res: StructureResult): string {
  const { title, detail } = describeDegradedReason(res.degradedReason);
  return `${title} — nothing was created. ${detail}`;
}
