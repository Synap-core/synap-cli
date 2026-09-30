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
 * Kept local to the CLI (not imported from @synap-core/hub-rest-client) because the
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

// Mirrors @synap-core/hub-rest-client's StructuredFollowUp/FollowUpChip. The chip is
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

// ─── Structure → execute routing (mirror of @synap-core/types) ──────────────
//
// The ONE mapper lives in `@synap-core/types` (`capture-routing-types.ts`):
// every capture door forwards the structure step's placement advice to
// execute through it, so the route decision event records the same data
// whatever door the capture came from. The CLI cannot import it today: it is
// published unbundled (`tsc`), depends on no `@synap-core/types`, and the
// published `@synap-core/types@1.12.0` predates the mapper. So this is a
// VERBATIM mirror, pinned by `test/capture-routing-parity.test.ts`, which runs
// the real mapper from the sibling source against this one. Retire it for a
// plain import once a `@synap-core/types` carrying the mapper is published.

/** The distribution behind an AI workspace pick (see the shared type). */
export interface WorkspaceDecisionRecord {
  decider: "jev" | "llm";
  model?: string;
  probabilities?: Record<string, number>;
  candidates?: Array<{ id: string; name: string }>;
}

/** The placement advice a `capture.structure` result carries (a subset). */
export interface CaptureStructureRouting {
  targetWorkspaceId?: string | null;
  targetWorkspaceReason?: string | null;
  targetWorkspaceConfidence?: number | null;
  targetWorkspaceDecision?: WorkspaceDecisionRecord | null;
  targetProjectId?: string | null;
  targetProjectReason?: string | null;
  targetProjectConfidence?: number | null;
}

/** The advisory routing fields `capture.execute` accepts. */
export interface CaptureExecuteRoutingHints {
  aiWorkspaceId?: string | null;
  aiWorkspaceConfidence?: number | null;
  aiWorkspaceReason?: string | null;
  aiWorkspaceDecision?: WorkspaceDecisionRecord | null;
  aiProjectId?: string | null;
  aiProjectConfidence?: number | null;
  aiProjectReason?: string | null;
}

/**
 * ADVISORY hints only — an AI pick proposes, it never places data. A user's
 * deliberate choice (`--workspace` / `--project`) is NOT a hint.
 */
export function captureExecuteRoutingHints(
  structured: CaptureStructureRouting
): CaptureExecuteRoutingHints {
  return {
    aiWorkspaceId: structured.targetWorkspaceId,
    aiWorkspaceConfidence: structured.targetWorkspaceConfidence,
    aiWorkspaceReason: structured.targetWorkspaceReason,
    aiWorkspaceDecision: structured.targetWorkspaceDecision,
    aiProjectId: structured.targetProjectId,
    aiProjectConfidence: structured.targetProjectConfidence,
    aiProjectReason: structured.targetProjectReason,
  };
}

/** The AI's workspace-side hints only (drop them when the user pinned a workspace). */
export function workspaceRoutingHints(structured: CaptureStructureRouting) {
  const { aiWorkspaceId, aiWorkspaceConfidence, aiWorkspaceReason, aiWorkspaceDecision } =
    captureExecuteRoutingHints(structured);
  return { aiWorkspaceId, aiWorkspaceConfidence, aiWorkspaceReason, aiWorkspaceDecision };
}

/** The AI's project-side hints only (drop them when the user pinned a project). */
export function projectRoutingHints(structured: CaptureStructureRouting) {
  const { aiProjectId, aiProjectConfidence, aiProjectReason } =
    captureExecuteRoutingHints(structured);
  return { aiProjectId, aiProjectConfidence, aiProjectReason };
}

// ─── Capture destination (structure → review → execute) ─────────────────────
//
// VERBATIM mirror of `CapturePlacement` / `WorkspaceChoice` /
// `deriveWorkspacePlacementView` in `@synap-core/types`
// (`capture-routing-types.ts`), for the same reason the mapper above is
// mirrored — the CLI resolves its SDK from a published dist that predates
// them. Pinned by `test/capture-routing-parity.test.ts`, which runs the REAL
// derivation from the sibling source against this one. The CLI is a HEADLESS
// door: it passes `interactive: false`, so a suggestion is never applied, only
// reported (`workspaceChoice: "ignored"`).

/** Where a capture will land, as `capture.structure` resolved it. */
export interface CapturePlacement {
  workspaceId: string | null;
  workspaceName: string | null;
  /** A deterministic rung placed it — never an AI guess. */
  deterministic: boolean;
  suggestion?: {
    workspaceId: string;
    workspaceName: string;
    reason: string | null;
    alternatives: Array<{ workspaceId: string; workspaceName: string; weight: number }>;
  };
}

/** What the person did with the destination field before saving. */
export type WorkspaceSelection =
  | { kind: "default" }
  | { kind: "chosen"; workspaceId: string; workspaceName: string }
  | { kind: "removed" };

export type WorkspaceChoice = "accepted" | "changed" | "removed" | "ignored";

export interface WorkspacePlacementView {
  destination: { workspaceId: string | null; workspaceName: string | null };
  aiSuggested: boolean;
  alternatives: NonNullable<CapturePlacement["suggestion"]>["alternatives"];
  canRemove: boolean;
  execute: { targetWorkspaceId?: string; workspaceChoice?: WorkspaceChoice };
}

/** THE destination rule — see the shared type's docblock. */
export function deriveWorkspacePlacementView(
  placement: CapturePlacement | null | undefined,
  selection: WorkspaceSelection,
  opts: { interactive: boolean }
): WorkspacePlacementView {
  if (!placement) {
    return {
      destination: { workspaceId: null, workspaceName: null },
      aiSuggested: false,
      alternatives: [],
      canRemove: false,
      execute: {},
    };
  }
  const suggestion = placement.suggestion;
  const base = {
    workspaceId: placement.workspaceId,
    workspaceName: placement.workspaceName,
  };
  const pinBase = (): WorkspacePlacementView["execute"] =>
    placement.deterministic && placement.workspaceId
      ? { targetWorkspaceId: placement.workspaceId }
      : {};

  if (selection.kind === "chosen") {
    return {
      destination: {
        workspaceId: selection.workspaceId,
        workspaceName: selection.workspaceName,
      },
      aiSuggested: false,
      alternatives: suggestion?.alternatives ?? [],
      canRemove: false,
      execute: {
        targetWorkspaceId: selection.workspaceId,
        ...(suggestion
          ? {
              workspaceChoice:
                selection.workspaceId === suggestion.workspaceId ? "accepted" : "changed",
            }
          : {}),
      },
    };
  }

  if (selection.kind === "removed" || !suggestion || !opts.interactive) {
    const choice: WorkspaceChoice | undefined = !suggestion
      ? undefined
      : selection.kind === "removed"
        ? "removed"
        : "ignored";
    return {
      destination: base,
      aiSuggested: false,
      alternatives: suggestion?.alternatives ?? [],
      canRemove: false,
      execute: {
        ...(choice === "removed" && placement.workspaceId
          ? { targetWorkspaceId: placement.workspaceId }
          : pinBase()),
        ...(choice ? { workspaceChoice: choice } : {}),
      },
    };
  }

  return {
    destination: {
      workspaceId: suggestion.workspaceId,
      workspaceName: suggestion.workspaceName,
    },
    aiSuggested: true,
    alternatives: suggestion.alternatives,
    canRemove: true,
    execute: { targetWorkspaceId: suggestion.workspaceId, workspaceChoice: "accepted" },
  };
}

/**
 * The headless placement fields the CLI sends to `/capture/execute` — the ONE
 * door, so the CLI can never hand-roll a destination. Headless ⇒ an AI
 * suggestion stays a proposal; a deterministic placement is pinned explicitly.
 */
export function headlessPlacementFields(
  structured: Pick<StructureResult, "placement">
): { targetWorkspaceId?: string; workspaceChoice?: WorkspaceChoice } {
  return deriveWorkspacePlacementView(structured.placement, { kind: "default" }, {
    interactive: false,
  }).execute;
}

/**
 * The workspace line for a structure result: the NAME the pod resolved (never
 * a raw id when a name is known) and the confidence percent, once.
 */
export function formatWorkspaceRouting(result: {
  targetWorkspaceId?: string | null;
  targetWorkspaceName?: string | null;
  targetWorkspaceConfidence?: number | null;
}): string | null {
  const label = result.targetWorkspaceName || result.targetWorkspaceId;
  if (!label) return null;
  const conf =
    typeof result.targetWorkspaceConfidence === "number"
      ? ` (${Math.round(result.targetWorkspaceConfidence * 100)}%)`
      : "";
  return `${label}${conf}`;
}

/** Response of POST /capture/structure (the AI plan — writes NOTHING). */
export interface StructureResult {
  proposals?: StructureProposal[];
  relations?: StructureRelation[];
  // May be a plain string OR a structured { question, suggestions[] } object.
  followUp?: string | FollowUp | null;
  targetWorkspaceId?: string | null;
  /** The pod's display name for `targetWorkspaceId` — what the CLI prints. */
  targetWorkspaceName?: string | null;
  targetWorkspaceConfidence?: number | null;
  targetWorkspaceReason?: string | null;
  targetWorkspaceDecision?: WorkspaceDecisionRecord | null;
  targetProjectId?: string | null;
  targetProjectConfidence?: number | null;
  targetProjectReason?: string | null;
  /**
   * The honest destination block — where the capture lands and, separately,
   * what the AI would SUGGEST. Read it through `headlessPlacementFields` /
   * `deriveWorkspacePlacementView`, never by digging at `targetWorkspaceId`
   * (which mixes a deterministic placement and an AI guess into one field).
   * Absent on an older pod.
   */
  placement?: CapturePlacement | null;
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
  /**
   * The AI's outstanding "move to X?" suggestion. NOTHING was moved — the
   * capture landed where it would have without the AI; re-file with an
   * explicit workspace to accept it. (This replaced `movedToWorkspace`, which
   * claimed a move the ladder never performs.)
   */
  pendingWorkspaceSwitch?: {
    suggestedWorkspaceId: string;
    suggestedWorkspaceName: string | null;
    reason: string | null;
    confidence: number | null;
  } | null;
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
  /**
   * The AI suggested another workspace and the pod did NOT move anything —
   * a proposal for the caller to confirm, never a receipt of a move.
   */
  pendingWorkspaceSwitch?: {
    suggestedWorkspaceId: string;
    suggestedWorkspaceName: string | null;
    reason: string | null;
    confidence: number | null;
  };
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
    ...(res.pendingWorkspaceSwitch?.suggestedWorkspaceId
      ? { pendingWorkspaceSwitch: res.pendingWorkspaceSwitch }
      : {}),
  };
}

/**
 * The one line every CLI surface prints for an outstanding workspace
 * suggestion. It says what to DO (re-file with `--workspace`), because the pod
 * moved nothing — the old "→ filed into workspace X" line reported a move that
 * never happened.
 */
export function formatPendingWorkspaceSwitch(
  outcome: Pick<CaptureExecuteOutcome, "pendingWorkspaceSwitch">
): string | null {
  const s = outcome.pendingWorkspaceSwitch;
  if (!s) return null;
  const label = s.suggestedWorkspaceName || s.suggestedWorkspaceId;
  const conf =
    typeof s.confidence === "number" ? ` (${Math.round(s.confidence * 100)}%)` : "";
  return `AI suggests workspace ${label}${conf} — nothing was moved. Re-file with --workspace ${s.suggestedWorkspaceId} to accept.`;
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
  | "llm_budget_exceeded"
  | "pdf_scanned_needs_ocr"
  | "pdf_missing_binary"
  | "vision_provider_not_configured"
  | "vision_provider_failed"
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
 * `@synap-core/hub-rest-client` (a file: link into synap-backend) and
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
    case "llm_budget_exceeded":
      return {
        title: "The monthly AI budget is used up",
        detail:
          "The Intelligence Service's monthly token budget is spent, so nothing was created. Re-run this import once the budget resets next month or an operator raises it.",
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
    case "vision_provider_failed":
      return {
        title: "Couldn't reach the AI that reads images",
        detail:
          "A vision model is configured but the call failed (an outage, an unfunded key or an unknown model). Re-run this import later; `synap doctor` checks the pod.",
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
