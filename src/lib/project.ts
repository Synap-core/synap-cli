/**
 * Project doors shared by `synap launch` and `synap market install`.
 *
 * The project is the cross-cutting lens both commands link installs to: launch
 * stands up a NEW company under a project, market install ADDS a package into an
 * existing (or the active) project. Both need the same two primitives — list the
 * pod's projects, and create one — so they live here instead of being duplicated.
 * The INTERACTIVE picking differs per command (launch weaves it into its guided
 * flow; market offers a standalone "Add to which project?" with a pod-wide
 * escape), so that stays in each command; only the data doors are shared.
 */

import { hubGet, hubPost, type HubConfig } from "./hub-client.js";
import { unwrapList } from "./unwrapList.js";

export interface ProjectRef {
  id: string;
  name: string;
}

/**
 * The pod's existing projects (`GET /projects`), normalized to `{id, name}`.
 * Best-effort: an unreachable/erroring pod yields `[]` rather than throwing, so
 * callers degrade to create-new / pod-wide instead of failing.
 */
export async function fetchProjects(cfg: HubConfig): Promise<ProjectRef[]> {
  try {
    const res = (await hubGet("/projects", {}, cfg)) as unknown;
    const list = unwrapList<Record<string, unknown>>(res, ["projects"]);
    return list
      .filter((p) => p.id)
      .map((p) => ({ id: String(p.id), name: String(p.name ?? p.id) }));
  } catch {
    return [];
  }
}

/**
 * Create a project (`POST /projects`). Governance may answer with a proposal
 * instead of creating directly — the caller distinguishes `id` (live) from
 * `proposalId` (queued for review) and messages accordingly.
 */
export async function createProject(
  cfg: HubConfig,
  input: { name: string; description?: string }
): Promise<{ id?: string; proposalId?: string; status?: string }> {
  return (await hubPost(
    "/projects",
    { name: input.name, description: input.description || undefined, status: "active" },
    cfg
  )) as { id?: string; proposalId?: string; status?: string };
}
