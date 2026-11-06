/**
 * One agent with a JOB on this computer (plan "Computer once, agents inside"
 * rev 3, pod document 31470fd5, flow 2a and D8):
 *
 *   synap agents add claude-code --as "CRM worker"
 *   synap worker --agent crm-worker --runtime claude-code   (first run)
 *
 * The engine stays the agent's type (`agentType: "claude-code"`), the job is
 * its role (`role: "crm-worker"`, `roleLabel: "CRM worker"`): on the pod it is
 * another agent than the engine's plain one, with its own key, permissions
 * and history. The key is minted with THIS computer's key, so the pod reads
 * the computer and the OS user from it, and the person approves it on
 * `/approve-agent/<keyId>`. Nothing else on the computer is re-keyed.
 *
 * A pod that does not know jobs is never asked (`pod-features.ts`): it would
 * ignore the role and mint for the plain agent, the one the person already
 * uses.
 *
 * Saved as the named agent `agents.<role>` (its key, its id, engine, job and
 * pod), which `synap worker --agent <role>` and `SYNAP_AGENT=<role>` read. It
 * is not written into the engine's own client config: the plain agent keeps
 * that.
 */

import { log } from "../utils/logger.js";
import { addAgent, type AgentProfile } from "./agents-config.js";
import { parseAgentJob, type AgentJob } from "./agent-jobs.js";
import { deviceAgentsFor } from "./device-connect.js";
import { jobRefusal, podKnowsAgentSeats, type PodFeature } from "./pod-features.js";

export interface RoleAgentPod {
  podUrl: string;
  /** THIS computer's key (`ensureComputerEnrolled`): the agent belongs to this computer. */
  computerKey: string;
  podName?: string;
}

export interface RoleAgentDeps {
  feature?: (podUrl: string) => Promise<PodFeature>;
  provision?: typeof import("./targets.js").provisionAgentKey;
  enroll?: typeof import("./targets.js").enrollAgentIfNeeded;
  save?: (name: string, profile: AgentProfile) => void;
  instanceId?: (surface: string) => string;
}

export type RoleAgentOutcome =
  | { ok: true; name: string; agentUserId: string; keyId?: string }
  | { ok: false; error: string };

const host = (podUrl: string): string => {
  try {
    return new URL(podUrl).host;
  } catch {
    return podUrl;
  }
};

/** Why `engine` + `--as <label>` cannot be asked, or the job. Pure. */
export function planRoleAgent(engine: string, label: string): { ok: true; job: AgentJob } | { ok: false; error: string } {
  if (deviceAgentsFor([engine]).length === 0) {
    return {
      ok: false,
      error: `"${engine}" is not an engine an agent with a job can run on: use one such as claude-code, codex or cursor.`,
    };
  }
  return parseAgentJob(label);
}

/**
 * Add the agent (`engine`, `job`) on this computer: check the pod knows jobs,
 * mint its key with the computer's key (the person approves it), enrol it
 * pod-wide unless `workspaceId`, save it as `agents.<role>`.
 */
export async function addRoleAgent(
  pod: RoleAgentPod,
  engine: string,
  job: AgentJob,
  scope: { workspaceId?: string } = {},
  deps: RoleAgentDeps = {}
): Promise<RoleAgentOutcome> {
  const feature = await (deps.feature ?? ((u: string) => podKnowsAgentSeats(u)))(pod.podUrl);
  const refusal = jobRefusal(feature, host(pod.podUrl));
  if (refusal) return { ok: false, error: refusal };

  const targets = await import("./targets.js");
  const provision = deps.provision ?? targets.provisionAgentKey;
  const enroll = deps.enroll ?? targets.enrollAgentIfNeeded;
  const instanceId = deps.instanceId ?? (await import("./machine-instance.js")).machineInstanceId;

  let minted: Awaited<ReturnType<typeof provision>>;
  try {
    minted = await provision(pod.podUrl, pod.computerKey, engine, {
      // Its own pending record: a request for this job never resumes the
      // plain agent's, nor the other way round.
      surfaceName: `${engine}:${job.role}`,
      // The computer's instance for this engine: `synap agents list` marks it
      // as this computer, and the pod reads the seat from the computer key.
      instanceId: instanceId(engine),
      job,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  await enroll(pod.podUrl, pod.computerKey, minted.agentUserId, scope.workspaceId, { quiet: true });

  (deps.save ?? addAgent)(job.role, {
    podName: pod.podName ?? "default",
    podUrl: pod.podUrl,
    apiKey: minted.hubApiKey,
    agentUserId: minted.agentUserId,
    ...(minted.keyId ? { keyId: minted.keyId } : {}),
    agentType: engine,
    role: job.role,
    label: job.roleLabel ?? job.role,
    ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
    createdAt: new Date().toISOString(),
  });
  return { ok: true, name: job.role, agentUserId: minted.agentUserId, keyId: minted.keyId };
}

/** The lines printed once the agent is added. */
export function printRoleAgentAdded(job: AgentJob, engine: string): void {
  log.success(`${job.roleLabel ?? job.role} (${engine}) is on this computer.`);
  log.dim(`Run it:  synap worker --agent ${job.role}`);
  log.dim(`Or as it, once:  SYNAP_AGENT=${job.role} synap <command>`);
}

/**
 * `synap worker --agent <name>` with no saved key for `name`: what to do
 * (D8). With `--runtime`, the agent with that job is asked for on this
 * computer (approval on the person's phone), unless `--no-create`. Without
 * it, the line that would, and a stop, so a typo never files a request for
 * the wrong engine. Pure.
 */
export function workerFirstRunPlan(
  agent: string,
  opts: { runtime?: string; create?: boolean }
):
  | { kind: "create"; engine: string; job: AgentJob }
  | { kind: "stop"; message: string } {
  const job = parseAgentJob(agent);
  const addLine = `synap agents add ${opts.runtime ?? "claude-code"} --as "${agent}"`;
  if (!opts.runtime) {
    // Not a job's slug: nothing to suggest beyond the saved names.
    if (!job.ok || job.job.role !== agent) return { kind: "stop", message: "" };
    return {
      kind: "stop",
      message:
        `To add it on this computer: \`${addLine}\`, ` +
        `or \`synap worker --agent ${agent} --runtime <engine>\` to ask for it from here.`,
    };
  }
  if (!job.ok) return { kind: "stop", message: job.error };
  if (opts.create === false) {
    return { kind: "stop", message: `No saved agent named "${agent}" (--no-create). Add it with \`${addLine}\`.` };
  }
  const plan = planRoleAgent(opts.runtime, agent);
  if (!plan.ok) return { kind: "stop", message: plan.error };
  // The worker's name IS the job's slug: a label typed as --agent ("CRM worker") would save under another name.
  if (plan.job.role !== agent) {
    return { kind: "stop", message: `Name the agent by its job's slug: --agent ${plan.job.role}.` };
  }
  return { kind: "create", engine: opts.runtime, job: plan.job };
}

// ─── adopt: a key this seat already holds becomes the named agent ────────────

export interface AdoptDeps {
  /** The key this seat holds for `from` on `podUrl` (`getSurfaceAgentKey`). */
  heldKey: (from: string, podUrl: string) => { hubApiKey: string; agentUserId: string; keyId?: string } | null;
  /** The named agent already saved under `name`, if any. */
  existing: (name: string) => AgentProfile | null;
  keyState: (podUrl: string, key: string) => Promise<import("./key-state.js").KeyState>;
  save: (name: string, profile: AgentProfile) => void;
}

/**
 * `synap agents adopt <job>` (plan 31470fd5 §6, the devbox cutover): the key
 * this OS user already holds for an engine (`--from claude-code`) is saved as
 * the named agent `<job>`, so `synap worker --agent <job>` runs as it. Mints
 * nothing and revokes nothing: the agent keeps its id, history and key. Its
 * job on the pod is set by the person on the agent's page (the Job door).
 *
 * The engine's slot is left as it is: the client config that holds the same
 * key (Claude Code's) is not touched, and the next `synap init` on this seat
 * gives it its own plain agent.
 */
export async function adoptHeldKey(
  role: string,
  opts: { from: string; podUrl: string; podName?: string },
  deps: AdoptDeps
): Promise<{ ok: true; agentUserId: string; keyId?: string } | { ok: false; error: string }> {
  const job = parseAgentJob(role);
  if (!job.ok) return job;
  if (job.job.role !== role) return { ok: false, error: `Name the agent by its job's slug: synap agents adopt ${job.job.role}` };
  if (deps.existing(role)) {
    return { ok: false, error: `An agent named "${role}" is already saved on this computer: nothing to adopt.` };
  }
  const held = deps.heldKey(opts.from, opts.podUrl);
  if (!held) {
    return { ok: false, error: `This OS user holds no ${opts.from} key for ${host(opts.podUrl)}: nothing to adopt.` };
  }
  const state = await deps.keyState(opts.podUrl, held.hubApiKey);
  if (state.state !== "active") {
    return {
      ok: false,
      error:
        state.state === "unreachable"
          ? `Could not ask ${host(opts.podUrl)} whether the ${opts.from} key works (${state.error ?? "unreachable"}). Nothing changed.`
          : `The ${opts.from} key this OS user holds is ${state.state.replace(/_/g, " ")}: reconnect it before adopting it. Nothing changed.`,
    };
  }
  const keyId = held.keyId ?? state.keyId;
  deps.save(role, {
    podName: opts.podName ?? "default",
    podUrl: opts.podUrl,
    apiKey: held.hubApiKey,
    agentUserId: held.agentUserId,
    ...(keyId ? { keyId } : {}),
    agentType: state.agentType ?? opts.from,
    role,
    label: job.job.roleLabel ?? role,
    createdAt: new Date().toISOString(),
  });
  return { ok: true, agentUserId: held.agentUserId, keyId };
}
