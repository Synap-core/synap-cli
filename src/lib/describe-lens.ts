/**
 * Shared lens display formatter.
 *
 * The lens itself — `{ workspaceId, projectId, focusSessionId }` — is resolved
 * by `resolveActiveLens()` in `session-lens.ts`; this module only answers "how
 * do we SHOW it". Before this existed, `commands/lens.ts` and
 * `commands/statusline.ts` each hand-rolled their own "no workspace → pod-wide"
 * / "no project → none" fallback text. One formatter now owns that logic so
 * new surfaces (Raycast, `orient`) can render the same lens consistently.
 *
 * Colors/links are deliberately NOT baked in here — `lens.ts` uses chalk,
 * `statusline.ts` uses raw ANSI + OSC-8 hyperlinks, and a future Raycast
 * consumer will use neither. Callers wrap the plain names/ids this module
 * resolves in whatever presentation their surface needs.
 */

export interface LensEntry {
  id: string;
  name?: string;
}

// ─── Provenance ───────────────────────────────────────────────────────────────
// WHICH rung supplied each field. A scope that resolves silently is what made
// the "Access denied to workspace" 403 class unexplainable: the operator could
// see WHAT they were scoped to but never WHY, so they could not tell a stale
// directory lens from a stale global config. Answering "why" is the whole point.

/** The rungs of the resolution ladder, highest precedence first. */
export type LensSource = "flag" | "session" | "directory" | "env" | "global";

/** Human wording for each rung — used verbatim in `synap lens` output. */
export const LENS_SOURCE_LABEL: Record<LensSource, string> = {
  flag: "explicit flag",
  session: "session lens",
  directory: "directory lens",
  env: "environment variable",
  global: "global config",
};

/** One candidate rung. `detail` is the concrete origin (a file path, an env var name). */
export interface LensRung {
  source: LensSource;
  workspaceId?: string;
  projectId?: string;
  focusSessionId?: string;
  detail?: string;
}

export interface LensFieldProvenance {
  id: string;
  source: LensSource;
  /** e.g. "/Users/x/repo/.synap/lens.json" or "SYNAP_WORKSPACE_ID". */
  detail?: string;
  /** "directory lens: /Users/x/repo/.synap/lens.json" — ready to print in parentheses. */
  origin: string;
}

export interface LensProvenance {
  workspace?: LensFieldProvenance;
  project?: LensFieldProvenance;
  session?: LensFieldProvenance;
}

/**
 * Resolve each lens field to the FIRST rung that supplies it.
 *
 * Pure and order-driven: the caller passes rungs highest-precedence first, so
 * this function can never disagree with the ladder in `hub-client.ts` about
 * priority — it just reports which entry won. Rungs the caller could not
 * evaluate (e.g. a pod-mismatched lens) are simply omitted by the caller,
 * which is exactly how they behave in resolution.
 */
export function resolveLensProvenance(rungs: LensRung[]): LensProvenance {
  const pick = (field: "workspaceId" | "projectId" | "focusSessionId"): LensFieldProvenance | undefined => {
    for (const rung of rungs) {
      const id = rung[field];
      if (!id) continue;
      return {
        id,
        source: rung.source,
        detail: rung.detail,
        origin: rung.detail
          ? `${LENS_SOURCE_LABEL[rung.source]}: ${rung.detail}`
          : LENS_SOURCE_LABEL[rung.source],
      };
    }
    return undefined;
  };
  return {
    workspace: pick("workspaceId"),
    project: pick("projectId"),
    session: pick("focusSessionId"),
  };
}

export interface ResolvedLens {
  workspace?: LensEntry;
  project?: LensEntry;
  session?: LensEntry;
}

export interface DescribedLensField {
  id: string;
  /** Display name, falling back to the raw id when no name was resolved. */
  name: string;
}

export interface DescribedLens {
  structured: {
    workspace?: DescribedLensField;
    project?: DescribedLensField;
    session?: DescribedLensField;
    /** True iff neither a workspace nor a project is bound — fully pod-wide. */
    podWide: boolean;
  };
  /** One "Label: value" line per field, in workspace/project/session order — value is the
   * placeholder text when unset, so callers can print it as-is or re-color it. */
  lines: Array<{ label: "Workspace" | "Project" | "Session"; value: string; bound: boolean }>;
}

function describeField(entry?: LensEntry): DescribedLensField | undefined {
  if (!entry?.id) return undefined;
  return { id: entry.id, name: entry.name?.trim() || entry.id };
}

export function describeLens(lens: ResolvedLens): DescribedLens {
  const workspace = describeField(lens.workspace);
  const project = describeField(lens.project);
  const session = describeField(lens.session);
  const podWide = !workspace && !project;

  const lines: DescribedLens["lines"] = [
    { label: "Workspace", value: workspace?.name ?? "— (pod-wide)", bound: Boolean(workspace) },
    { label: "Project", value: project?.name ?? "— none", bound: Boolean(project) },
    { label: "Session", value: session?.name ?? "— none", bound: Boolean(session) },
  ];

  return { structured: { workspace, project, session, podWide }, lines };
}
