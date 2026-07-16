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
