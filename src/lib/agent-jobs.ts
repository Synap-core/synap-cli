/**
 * An agent's JOB (plan "Computer once, agents inside" rev 3, pod document
 * 31470fd5, D1/D8): the same engine with another job on the same computer and
 * OS user is ANOTHER agent, with its own key, permissions and history ("CRM
 * worker" and "Dev worker", both Claude Code on the devbox). On the wire a job
 * is `role` (a slug, "crm-worker") plus `roleLabel` (its name, "CRM worker");
 * no job = the engine's plain agent, as before.
 *
 * The grammar mirrors `@synap-core/types/agents` (`agentRoleSlug`,
 * `isAgentRoleSlug`, `AGENT_ROLE_LABEL_MAX`, synap-backend
 * packages/types/src/agents/seats.ts). A mirror, because the published types
 * this CLI depends on predate it: a slug the pod refuses would 400 the whole
 * request, so the CLI checks it first.
 */

/** A job slug: lowercase letters, digits and dashes, 1-63, no leading dash. */
const ROLE_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const AGENT_ROLE_LABEL_MAX = 80;

export function isAgentRoleSlug(v: unknown): v is string {
  return typeof v === "string" && ROLE_SLUG.test(v);
}

/** "CRM worker" → "crm-worker"; "" when nothing usable is left. */
export function agentRoleSlug(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
}

export interface AgentJob {
  /** The slug the pod keys the agent by, and the CLI saves its key under. */
  role: string;
  /**
   * What the person typed, shown on the approval page and the agent's page.
   * Absent when they typed the slug itself: the pod names it ("Crm worker").
   */
  roleLabel?: string;
}

/**
 * The job `--as "<job>"` asks for, or why it cannot be one. A label that is
 * already a slug ("crm-worker") is its own slug and sends no label: the pod
 * names it.
 */
export function parseAgentJob(label: string): { ok: true; job: AgentJob } | { ok: false; error: string } {
  const typed = label.trim();
  const role = agentRoleSlug(typed);
  if (!isAgentRoleSlug(role)) {
    return { ok: false, error: `"${label}" is not a job: use a few words with letters or digits, e.g. --as "CRM worker".` };
  }
  if (typed === role) return { ok: true, job: { role } };
  return { ok: true, job: { role, roleLabel: typed.slice(0, AGENT_ROLE_LABEL_MAX) } };
}

/**
 * Which engine `synap init --as "<job>"` gives the job to: the one engine
 * asked for, else Claude Code when it is among them. Several engines and no
 * Claude Code is ambiguous: the person names one with `--agents`. Pure.
 */
export function initJobFor(
  label: string,
  engines: readonly string[]
): { ok: true; engine: string; job: AgentJob } | { ok: false; error: string } {
  const parsed = parseAgentJob(label);
  if (!parsed.ok) return parsed;
  const engine = engines.length === 1 ? engines[0] : engines.includes("claude-code") ? "claude-code" : undefined;
  if (!engine) {
    return {
      ok: false,
      error:
        engines.length === 0
          ? `--as gives an agent a job, but no agent is asked for: add --agents claude-code (or another engine).`
          : `--as gives ONE agent a job: name it with --agents <engine> (asked for: ${engines.join(", ")}).`,
    };
  }
  return { ok: true, engine, job: parsed.job };
}
