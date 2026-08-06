/**
 * synap capture — the one canonical structured-WRITE verb.
 *
 * SMART MODE (no --type): `synap capture "free text"`
 *   → POST /capture/structure (AI pipeline: proposals + relations + followUp)
 *   → renders a proposal table, prompts y/N, then POST /capture/execute.
 *
 * TYPED MODE (--type): `synap capture --type gotcha --claim "…" [--why] [--evidence] [--tags]`
 *   → POST /entities as a typed `knowledge` entity; `ek_type` (gotcha|lesson|decision|
 *     reference) discriminates the kind — ONE store, type tags (the canonical pattern,
 *     NOT a residual dump). The workspace lens supplies the domain (no
 *     `engineering_knowledge`). A formal decision RECORD (rationale/alternatives/status
 *     lifecycle) comes from smart `capture "<text>"` or `create entity --profile=decision`.
 *
 * Workspace routing for Work-lane knowledge: --workspace (explicit pin) >
 * --team (first product ws, when configured) > omit workspaceId (server-derived
 * / pod-wide preferred). Never default-pin to the active profile workspace —
 * that commonly is Pod Admin and would dump domain knowledge into admin.
 */

import chalk from "chalk";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { log } from "../utils/logger.js";
import {
  resolveHubConfig,
  resolveUserId,
  hubPost,
  hubGet,
  readActiveSessionId,
  type HubConfig,
  renderHubError,
} from "../lib/hub-client.js";
import { unwrapList } from "../lib/unwrapList.js";
import { getAgentWorkspaceRouting } from "../lib/pod.js";
import { resolvePodWide } from "../lib/pod-wide.js";
import {
  laneFromSource,
  resolveWorkspaceName,
  formatLaneLine,
  laneJsonFields,
  writeGovernance,
  type LaneReport,
} from "../lib/capture-lane.js";
import {
  isDegraded,
  degradedMessage,
  readCaptureExecute,
  type StructureResult,
  type ExecuteResult,
} from "../lib/capture-structure.js";
import { UUID_RE } from "../lib/id.js";

export type KnowledgeType = "gotcha" | "lesson" | "decision" | "reference";

// ─── Client-side length guard ────────────────────────────────────────────────
// Captures used to die SERVER-SIDE with a raw "String length 1404 > maximum
// 1000" after the user had already composed + confirmed — surface the same
// caps client-side, BEFORE sending, so a too-long capture gets a heads-up
// instead of a mid-flight rejection. Not a hard block: --yes/--json paths and
// a declined truncation still send as-is and let the pod be the final judge
// (the caps below mirror the pod's contract but are not re-validated here).
//
// Mirrors:
//   - synap-backend CaptureStructureRequestSchema.text
//     (packages/api/src/routers/hub-protocol/rest/_codecs/misc.ts)
//   - the `knowledge` profile's ek_claim/ek_why/ek_evidence property defs
//     (packages/database/src/utils/ensure-system-profiles.ts)
const SMART_TEXT_MAX = 8000;
const CLAIM_MAX = 1000;
const WHY_MAX = 5000;
const EVIDENCE_MAX = 2000;

/**
 * Warn when `value` exceeds `max`, and offer to truncate (interactive) or
 * proceed as-is. Returns the value to send (possibly truncated), or
 * `undefined` if the user aborted.
 *
 * Non-interactive (`--yes` / `--json`): warns to stderr and proceeds unchanged
 * — this is a heads-up, not a client-side hard block; the pod is still free to
 * accept a since-raised cap.
 */
async function guardLength(
  label: string,
  value: string,
  max: number,
  opts: { yes?: boolean; json?: boolean }
): Promise<string | undefined> {
  if (value.length <= max) return value;

  if (opts.yes || opts.json) {
    log.warn(`${label} is ${value.length} chars (pod limit ~${max}) — sending as-is; the pod may reject it.`);
    return value;
  }

  log.warn(`${label} is ${value.length} chars — the pod's limit is ~${max}.`);
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(
      chalk.bold(`  Truncate to ${max} chars and continue? [Y/n/(a)bort] `)
    );
    const a = answer.trim().toLowerCase();
    if (a === "n" || a === "abort" || a === "a") return undefined;
    return value.slice(0, max);
  } finally {
    rl.close();
  }
}

export interface CaptureOpts {
  /** Smart mode: positional free-text (no --type). When present, uses AI /capture/structure pipeline. */
  text?: string;
  /** Typed mode: one of gotcha|lesson|decision|reference */
  type?: KnowledgeType;
  claim?: string;
  /** Typed mode: full Markdown explanation, stored through the canonical body door. */
  content?: string;
  why?: string;
  evidence?: string;
  tags?: string;
  /** Pin to first product workspace (from connect routing); otherwise omit workspaceId */
  team?: boolean;
  /** Explicit workspace pin — highest priority (otherwise workspaceId is omitted) */
  workspace?: string;
  /**
   * Explicit project pin (id or name) — highest priority for the project lens.
   * Falls back to SYNAP_PROJECT_ID / the active session's pinned project
   * (already threaded into `resolveHubConfig().projectId`) when omitted.
   */
  project?: string;
  /**
   * GLOBAL lane: write a pod-wide procedural runbook to `knowledge_keys`
   * (cross-cutting best-practice/how-to, visible in every workspace) instead of
   * a domain `knowledge` entity (Work lane).
   */
  global?: boolean;
  /** Canonical spelling of the same opt-in (`--pod-wide`); `global` is the alias. */
  podWide?: boolean;
  /** Optional stable key (namespace:slug) for a --pod-wide runbook; derived if absent. */
  key?: string;
  json?: boolean;
  /** Skip the y/N confirmation prompt (smart mode only) */
  yes?: boolean;
  /** Link the captured knowledge to the active session */
  session?: boolean;
}

/**
 * Resolve the workspace for a DOMAIN capture (the `knowledge` entity, the Work
 * lane).
 *
 * Priority: --workspace (explicit pin) > --team (first product ws when
 * configured) > omit workspaceId.
 *
 * Default is intentional omit: sending an ambient/active workspaceId is a
 * backend rung-1 pin. Team profiles often default active workspace to Pod Admin,
 * which dumped domain knowledge into admin. Leaving workspaceId out lets the
 * server place knowledge (pod-wide preferred for knowledge kinds / AI routing on
 * smart capture).
 *
 * NOTE: the agent-memory ("AI-self") lane was removed — everything routes to a
 * real lane: Work (here), Global (`--global` → knowledge_keys), or User
 * (`record_observation` → user_observation).
 */
async function resolveKnowledgeWorkspace(
  opts: { team?: boolean; workspace?: string }
): Promise<{ workspaceId: string | undefined; source: string }> {
  if (opts.workspace) {
    return { workspaceId: opts.workspace, source: "explicit" };
  }
  if (opts.team) {
    const routing = getAgentWorkspaceRouting();
    const teamWs = routing?.productWorkspaceIds?.[0];
    if (teamWs) {
      return { workspaceId: teamWs, source: "team" };
    }
    // --team asked for a product pin but none is configured: still omit.
    // Do not fall back to active workspace (that reintroduces the Admin dump).
    return {
      workspaceId: undefined,
      source: "server-derived (no team workspace configured — pod-wide preferred for knowledge)",
    };
  }
  return {
    workspaceId: undefined,
    source: "server-derived (pod-wide preferred for knowledge)",
  };
}

/**
 * Resolve a `--project` value (id or name) to a project id on the active pod.
 * Mirrors `synap import`'s resolveProjectArg — same shape, same "not found"
 * wording, kept local here since neither command shares a project-resolution
 * lib yet. Throws on no match so a typo'd project name fails loud instead of
 * silently dropping the pin.
 */
async function resolveProjectArg(value: string, cfg: HubConfig): Promise<string> {
  if (UUID_RE.test(value)) return value;
  const res = (await hubGet("/projects", {}, cfg)) as unknown;
  const list = unwrapList<Record<string, unknown>>(res, ["projects"]);
  const match = list.find((p) => String(p.name ?? "").toLowerCase() === value.toLowerCase());
  if (!match) {
    const names = list.map((p) => String(p.name ?? p.id)).join(", ");
    throw new Error(`Project '${value}' not found.${names ? ` Available: ${names}` : ""}`);
  }
  return String(match.id);
}

/**
 * Render the pod's project-link receipt honestly — never a bare "✓ stored"
 * that hides a dropped project coordinate. Read DEFENSIVELY: the two write
 * doors this command uses shape their receipt differently —
 *   - POST /capture/execute → `res.project = { projectId, rung, status }`
 *   - POST /entities        → `res.writeReceipt.projectId` (present only once
 *     applied — omitted while the write is still a pending proposal)
 * and the exact field name may still shift as the backend's receipt work
 * lands, so this checks both shapes rather than assuming one.
 */
function renderProjectReceipt(res: Record<string, unknown>, requestedProjectId: string | undefined, isProposed: boolean): void {
  if (!requestedProjectId) return;

  const captureProject = res.project as { projectId?: string; status?: string } | undefined;
  if (captureProject?.projectId) {
    if (captureProject.status === "linked") {
      log.dim(`  → linked to project ${captureProject.projectId.slice(0, 8)}`);
    } else if (captureProject.status === "proposed") {
      log.dim(`  → project ${captureProject.projectId.slice(0, 8)} proposed (advisory — awaiting confirm, not yet linked)`);
    } else {
      log.dim(`  → project ${captureProject.projectId.slice(0, 8)} (${captureProject.status ?? "unknown"})`);
    }
    return;
  }

  const writeReceipt = res.writeReceipt as { projectId?: string } | undefined;
  if (writeReceipt?.projectId) {
    log.dim(`  → linked to project ${writeReceipt.projectId.slice(0, 8)}`);
    return;
  }

  if (isProposed) {
    // The whole write is pending review — the project link rides along with
    // it and applies on approval, not dropped.
    log.dim(`  → project ${requestedProjectId.slice(0, 8)} will link on approval (write is pending review)`);
    return;
  }

  // A project pin was sent but no receipt confirms it — say so plainly rather
  // than letting a silent drop look like success.
  log.dim(`  → project NOT linked (pod did not confirm ${requestedProjectId.slice(0, 8)} — it may not be reachable from this workspace)`);
}

/** Slugify free text into a knowledge_keys slug fragment. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "entry";
}

/**
 * GLOBAL lane: write a pod-wide procedural runbook to `knowledge_keys`.
 * Cross-cutting best-practice/how-to, addressed by a stable `namespace:slug` key
 * and visible in every workspace (pod-wide). The kind (gotcha/lesson/decision/
 * reference) becomes the namespace; the claim derives the slug unless --key given.
 */
async function captureGlobalRunbook(
  opts: CaptureOpts,
  cfg: HubConfig,
  authorUserId: string
): Promise<void> {
  const type = opts.type ?? "reference";
  const claim = opts.claim ?? opts.text ?? "";
  const key = opts.key ?? `${type}:${slugify(claim)}`;
  const [namespace, ...slugParts] = key.split(":");
  const slug = slugParts.join(":") || slugify(claim);

  const valueParts = [claim];
  if (opts.why) valueParts.push(`\n**Why:** ${opts.why}`);
  if (opts.evidence) valueParts.push(`\n**Evidence:** ${opts.evidence}`);
  if (opts.tags) valueParts.push(`\n_tags: ${opts.tags}_`);

  const res = await hubPost("/knowledge", {
    key,
    namespace,
    slug,
    value: valueParts.join("\n"),
    author: authorUserId,
    // workspaceId omitted → pod-wide (null). The Global lane is, by definition,
    // cross-workspace. (Workspace-scoped knowledge_keys await a backend fix —
    // POST /knowledge currently drops workspaceId; domain knowledge uses the
    // `knowledge` entity instead, which IS workspace-scoped.)
  }, cfg) as Record<string, unknown>;

  const report: LaneReport = {
    lane: "global",
    workspaceId: undefined,
    workspaceName: "pod-wide",
    governance: "auto",
  };

  if (opts.json) {
    console.log(JSON.stringify({ key, id: res.id, stored: true, ...laneJsonFields(report) }, null, 2));
    return;
  }
  log.success(`[${type}] ${claim.slice(0, 80)}`);
  log.dim(`  key: ${key}`);
  console.log("  " + formatLaneLine(report));
}

// ─── Smart capture mode (no --type) ──────────────────────────────────────────
// Structure/execute wire shapes + the degraded/execute interpreters are shared
// with `synap import` in lib/capture-structure.ts (ONE mirror, no drift).

/** Render the /capture/structure result as a compact human-readable summary. */
function renderStructureResult(result: StructureResult): void {
  const proposals = result.proposals ?? [];
  const relations = result.relations ?? [];
  const followUp = result.followUp;

  if (proposals.length === 0) {
    log.dim("No entity proposals extracted.");
    return;
  }

  log.heading("Proposed entities");
  // Column widths
  const typeW = Math.min(18, Math.max(6, ...proposals.map((p) => p.profileSlug.length)));
  const titleW = Math.min(48, Math.max(10, ...proposals.map((p) => p.title.length)));
  const header = [
    chalk.bold("#".padEnd(3)),
    chalk.bold("Type".padEnd(typeW)),
    chalk.bold("Title".padEnd(titleW)),
  ].join("  ");
  console.log("  " + header);
  console.log("  " + chalk.dim("-".repeat(3 + 2 + typeW + 2 + titleW)));
  for (let i = 0; i < proposals.length; i++) {
    const p = proposals[i];
    const row = [
      chalk.dim(String(i + 1).padEnd(3)),
      chalk.cyan(p.profileSlug.slice(0, typeW).padEnd(typeW)),
      p.title.slice(0, titleW).padEnd(titleW),
    ].join("  ");
    console.log("  " + row);
    if (p.description) {
      log.dim(`     ${p.description.slice(0, 80)}`);
    }
  }

  if (relations.length > 0) {
    log.blank();
    log.dim(`  ${relations.length} relation${relations.length !== 1 ? "s" : ""} will be created.`);
  }

  if (result.targetWorkspaceId || result.targetProjectId) {
    log.blank();
    if (result.targetWorkspaceId) {
      const conf =
        typeof result.targetWorkspaceConfidence === "number"
          ? ` (${Math.round(result.targetWorkspaceConfidence * 100)}%)`
          : "";
      log.dim(`  → workspace: ${result.targetWorkspaceId}${conf}`);
      if (result.targetWorkspaceReason) {
        log.dim(`      ${result.targetWorkspaceReason.slice(0, 90)}`);
      }
    }
    if (result.targetProjectId) {
      const conf =
        typeof result.targetProjectConfidence === "number"
          ? ` (${Math.round(result.targetProjectConfidence * 100)}%)`
          : "";
      log.dim(`  → project:   ${result.targetProjectId}${conf}`);
      if (result.targetProjectReason) {
        log.dim(`      ${result.targetProjectReason.slice(0, 90)}`);
      }
    }
  }

  // followUp may be a bare string (previously dropped — the `.question` guard
  // never matched) or a { question, suggestions[] } object (chips previously
  // rendered as "[object Object]"). Handle both; render each chip by its label.
  if (followUp) {
    const question = typeof followUp === "string" ? followUp : followUp.question;
    if (question) {
      log.blank();
      log.info(`Follow-up: ${question}`);
      const chips = typeof followUp === "string" ? [] : followUp.suggestions ?? [];
      for (const c of chips) {
        log.dim(`  · ${c.label ?? c.value}`);
      }
    }
  }
}

async function runSmartCapture(rawText: string, opts: CaptureOpts): Promise<void> {
  const guarded = await guardLength("Capture text", rawText, SMART_TEXT_MAX, opts);
  if (guarded === undefined) {
    log.dim("Aborted.");
    return;
  }
  const text = guarded;

  const cfg = await resolveHubConfig();
  const userId = await resolveUserId(cfg);
  // Do NOT default-pin cfg.workspaceId — omit unless --workspace / --team.
  const { workspaceId, source } = await resolveKnowledgeWorkspace(opts);

  // Default Work-lane knowledge omits workspaceId so the pod can place it
  // (AI routing on smart capture / pod-wide preferred for knowledge kinds).
  if (!workspaceId && !opts.json) {
    log.dim(`  Placement: ${source} — workspaceId omitted.`);
    log.dim("  Pin with --workspace <id> or --team (first product workspace).");
  }

  // Project pin: explicit --project (id or name) wins; otherwise the ambient
  // lens (SYNAP_PROJECT_ID / the active Claude session's pinned project,
  // already resolved into cfg.projectId by resolveHubConfig).
  let projectId: string | undefined;
  try {
    projectId = opts.project ? await resolveProjectArg(opts.project, cfg) : cfg.projectId;
  } catch (e) {
    console.error(chalk.red((e as Error).message));
    process.exit(1);
  }

  // 1. Structure
  const smartSessionId = opts.session ? readActiveSessionId() : undefined;
  const structureBody: Record<string, unknown> = {
    userId,
    text,
    ...(workspaceId ? { workspaceId } : {}),
    ...(smartSessionId ? { sessionId: smartSessionId } : {}),
  };
  const structureRes = await hubPost("/capture/structure", structureBody, cfg) as StructureResult;

  // Degraded: the IS structurer is down. The server returns a raw `item`
  // stand-in, but we create nothing (browser does the same via
  // offlineFallback:false) — tell the user, don't silently downgrade the
  // capture into an unstructured blob behind a success line.
  if (isDegraded(structureRes)) {
    if (opts.json) {
      console.log(JSON.stringify({
        degraded: true,
        degradedReason: structureRes.degradedReason ?? null,
        created: 0,
        message: degradedMessage(structureRes),
      }, null, 2));
    } else {
      log.warn(degradedMessage(structureRes));
    }
    return;
  }

  // Explicit --workspace is a deliberate pin: send it as-is, no AI routing hints.
  // Otherwise forward the AI's routing signal and let the backend decide
  // (auto = AI target wins over ambient when confidence is high enough AND the
  // user is a member).
  const isExplicitOverride = Boolean(opts.workspace);
  const routingFields: Record<string, unknown> = isExplicitOverride
    ? {}
    : {
        workspaceRouting: "auto",
        aiWorkspaceId: structureRes.targetWorkspaceId,
        aiWorkspaceConfidence: structureRes.targetWorkspaceConfidence,
        aiWorkspaceReason: structureRes.targetWorkspaceReason,
      };
  // Project: the explicit pin (--project / ambient lens) is the ONE
  // deterministic field and always wins when present. The AI's own guess is
  // forwarded ONLY as advisory (aiProjectId) — never promoted to the
  // deterministic `projectId` field. That promotion was a real bug here
  // (an AI guess would auto-link and widen cross-workspace access before the
  // user ever confirmed it); the backend's aiProjectId path records it as a
  // suggestion instead and never auto-links it.
  if (projectId) {
    routingFields.projectId = projectId;
  } else if (structureRes.targetProjectId) {
    routingFields.aiProjectId = structureRes.targetProjectId;
    routingFields.aiProjectConfidence = structureRes.targetProjectConfidence;
    routingFields.aiProjectReason = structureRes.targetProjectReason;
  }

  if (opts.json) {
    // --json without --yes: print structure result and exit
    if (!opts.yes) {
      console.log(JSON.stringify(structureRes, null, 2));
      return;
    }
    // --json + --yes: also execute and print combined result
    const executeRes = await hubPost("/capture/execute", {
      userId,
      ...(workspaceId ? { workspaceId } : {}),
      ...(smartSessionId ? { sessionId: smartSessionId } : {}),
      ...routingFields,
      entities: structureRes.proposals,
      relations: structureRes.relations ?? [],
    }, cfg) as ExecuteResult;
    const report = await buildSmartLaneReport(executeRes, workspaceId, source, cfg);
    console.log(JSON.stringify({
      structure: structureRes,
      execute: executeRes,
      ...(projectId ? { requestedProjectId: projectId } : {}),
      ...laneJsonFields(report),
    }, null, 2));
    return;
  }

  // 2. Render proposals
  renderStructureResult(structureRes);

  const count = structureRes.proposals?.length ?? 0;
  if (count === 0) return;

  // 3. Confirm
  let confirmed = opts.yes ?? false;
  if (!confirmed) {
    log.blank();
    const rl = readline.createInterface({ input, output });
    try {
      const answer = await rl.question(
        chalk.bold(`  Create ${count} entr${count !== 1 ? "ies" : "y"}? [y/N] `)
      );
      confirmed = answer.trim().toLowerCase() === "y";
    } finally {
      rl.close();
    }
  }

  if (!confirmed) {
    log.dim("Aborted.");
    return;
  }

  // 4. Execute
  const executeRes = await hubPost("/capture/execute", {
    userId,
    ...(workspaceId ? { workspaceId } : {}),
    ...(smartSessionId ? { sessionId: smartSessionId } : {}),
    ...routingFields,
    entities: structureRes.proposals,
    relations: structureRes.relations ?? [],
  }, cfg) as ExecuteResult;

  // Report what the pod ACTUALLY returned — applied vs proposed vs
  // nothing-new — never the planned proposal count.
  const outcome = readCaptureExecute(executeRes);
  const report = await buildSmartLaneReport(executeRes, workspaceId, source, cfg);

  if (outcome.proposed) {
    log.info("Capture proposed — under review, not yet stored.");
    if (outcome.proposalId) log.dim(`  proposal: ${outcome.proposalId}`);
    if (outcome.reviewUrl) log.dim(`  review: ${outcome.reviewUrl}`);
  } else {
    const n = outcome.entitiesCreated;
    log.success(`${n} entr${n !== 1 ? "ies" : "y"} created.`);
    if (outcome.entitiesLinked) {
      log.dim(`  ${outcome.entitiesLinked} linked to existing entit${outcome.entitiesLinked !== 1 ? "ies" : "y"}.`);
    }
    if (outcome.relationsCreated) {
      log.dim(`  ${outcome.relationsCreated} relation${outcome.relationsCreated !== 1 ? "s" : ""} created.`);
    }
    if (outcome.movedToWorkspace) {
      log.dim(`  → filed into workspace ${outcome.movedToWorkspace}`);
    }
  }
  console.log("  " + formatLaneLine(report));
  renderProjectReceipt(executeRes as unknown as Record<string, unknown>, projectId, outcome.proposed);
}

/**
 * Build the lane report for a smart-capture execute response. Governance
 * (auto vs proposed) is derived by the ONE shared interpreter so this doesn't
 * re-implement a third detector.
 */
async function buildSmartLaneReport(
  executeRes: ExecuteResult,
  workspaceId: string | undefined,
  source: string,
  cfg: HubConfig
): Promise<LaneReport> {
  return {
    lane: laneFromSource(source),
    workspaceId,
    workspaceName: workspaceId
      ? await resolveWorkspaceName(workspaceId, cfg)
      : "server-derived (pod-wide preferred)",
    governance: readCaptureExecute(executeRes).proposed ? "proposed" : "auto",
  };
}

// ─── Legacy engineering-memory capture ────────────────────────────────────────

export async function captureKnowledge(opts: CaptureOpts): Promise<void> {
  try {
    // Mutual exclusion: smart mode (positional text) and typed mode (--type/--claim)
    // are two distinct flows. Mixing them silently drops one — fail loud instead.
    if (opts.text !== undefined && opts.type !== undefined) {
      console.error(chalk.red("Cannot mix smart mode (positional text) with typed mode (--type/--claim)."));
      console.error(chalk.dim("  Use one: `synap capture \"free text\"`  OR  `synap capture --type gotcha --claim \"…\"`"));
      process.exit(1);
    }

    // Smart mode: positional text with no --type
    if (opts.text !== undefined && opts.type === undefined) {
      await runSmartCapture(opts.text, opts);
      return;
    }

    // Legacy mode: --type is required
    if (!opts.type) {
      console.error(chalk.red("Missing required option: --type <gotcha|lesson|decision|reference>"));
      console.error(chalk.dim("  Or pass free text as a positional arg for smart capture: synap capture \"your text\""));
      process.exit(1);
    }
    if (!opts.claim) {
      console.error(chalk.red("Missing required option: --claim <text>"));
      process.exit(1);
    }

    // Client-side length guard — catch the "String length N > maximum 1000"
    // server rejection BEFORE it fires, with a chance to truncate/abort
    // instead of a mid-flight failure after composing + confirming.
    const guardedClaim = await guardLength("--claim", opts.claim, CLAIM_MAX, opts);
    if (guardedClaim === undefined) {
      log.dim("Aborted.");
      return;
    }
    opts.claim = guardedClaim;
    if (opts.why) {
      const guardedWhy = await guardLength("--why", opts.why, WHY_MAX, opts);
      if (guardedWhy === undefined) {
        log.dim("Aborted.");
        return;
      }
      opts.why = guardedWhy;
    }
    if (opts.evidence) {
      const guardedEvidence = await guardLength("--evidence", opts.evidence, EVIDENCE_MAX, opts);
      if (guardedEvidence === undefined) {
        log.dim("Aborted.");
        return;
      }
      opts.evidence = guardedEvidence;
    }

    const cfg = await resolveHubConfig();
    const userId = await resolveUserId(cfg);

    // GLOBAL lane: pod-wide procedural runbook → knowledge_keys.
    // Canonical spelling is `--pod-wide`; `--global` is the retained alias.
    if (resolvePodWide(opts)) {
      await captureGlobalRunbook(opts, cfg, userId);
      return;
    }

    // Do NOT default-pin cfg.workspaceId — omit unless --workspace / --team.
    const { workspaceId, source } = await resolveKnowledgeWorkspace(opts);

    // Default Work-lane knowledge omits workspaceId so the pod can place it
    // (server-derived / pod-wide preferred for knowledge kinds).
    if (!workspaceId && !opts.json) {
      log.dim(`  Placement: ${source} — workspaceId omitted.`);
      log.dim("  Pin with --workspace <id> or --team (first product workspace).");
    }

    // Project pin: explicit --project (id or name) wins; otherwise the ambient
    // lens already resolved by resolveHubConfig (SYNAP_PROJECT_ID / the active
    // Claude session's pinned project). Previously this coordinate was simply
    // dropped by `capture` — --pod resolved url+key but never the project lens.
    let projectId: string | undefined;
    try {
      projectId = opts.project ? await resolveProjectArg(opts.project, cfg) : cfg.projectId;
    } catch (e) {
      console.error(chalk.red((e as Error).message));
      process.exit(1);
    }

    const tags = opts.tags
      ? opts.tags.split(",").map((t) => t.trim()).filter(Boolean)
      : [];

    const title = opts.claim.slice(0, 120);

    // Every --type entry is a typed `knowledge` entity; ek_type discriminates the
    // kind. This is "one store, type tags" (the research-canonical pattern) — NOT a
    // residual catch-all: each row is typed by ek_type and lives in the workspace
    // lens that supplies its domain (so no `engineering_knowledge`). A structured
    // decision RECORD (rationale/alternatives/status) is a different artifact, reached
    // via smart `capture "<text>"` or `create entity --profile=decision`.
    const sessionId = opts.session ? readActiveSessionId() : undefined;

    const res = await hubPost("/entities", {
      userId,
      ...(workspaceId ? { workspaceId } : {}),
      profileSlug: "knowledge",
      title,
      ...(sessionId ? { sessionId } : {}),
      ...(projectId ? { projectId } : {}),
      properties: {
        knowledgeForm: opts.type === "gotcha" ? "caution" : "insight",
        ek_type: opts.type,
        ek_claim: opts.claim,
        ...(opts.why ? { ek_why: opts.why } : {}),
        ...(opts.evidence ? { ek_evidence: opts.evidence } : {}),
        ...(tags.length > 0 ? { ek_tags: tags } : {}),
      },
      ...(opts.content?.trim().length ? { content: opts.content } : {}),
    }, cfg) as Record<string, unknown>;

    // Governance may queue the write as a proposal rather than creating
    // directly — read the real outcome via the ONE shared detector.
    const isProposed = writeGovernance(res) === "proposed";

    // Declare which lane + workspace + governance this capture took, so the
    // caller always knows where its knowledge landed.
    const report: LaneReport = {
      lane: laneFromSource(source),
      workspaceId,
      workspaceName: workspaceId
        ? await resolveWorkspaceName(workspaceId, cfg)
        : "server-derived (pod-wide preferred)",
      governance: isProposed ? "proposed" : "auto",
    };

    if (opts.json) {
      const writeReceipt = res.writeReceipt as { projectId?: string } | undefined;
      if (isProposed) {
        console.log(JSON.stringify({
          proposed: true,
          proposalId: res.proposalId ?? res.id,
          reviewUrl: res.reviewUrl ?? null,
          message: "Write queued for approval — not yet stored.",
          ...(projectId ? { requestedProjectId: projectId } : {}),
          ...laneJsonFields(report),
        }, null, 2));
      } else {
        console.log(JSON.stringify({
          id: res.id,
          stored: true,
          workspace: source,
          ...(projectId ? { requestedProjectId: projectId, linkedProjectId: writeReceipt?.projectId ?? null } : {}),
          ...laneJsonFields(report),
        }, null, 2));
      }
      return;
    }

    if (isProposed) {
      log.warn(`Queued for approval — not yet stored.`);
      log.dim(`  The target workspace requires human review for agent writes.`);
      if (res.reviewUrl) log.dim(`  Review: ${String(res.reviewUrl)}`);
      else log.dim(`  Open Synap and approve the pending proposal to persist this entry.`);
      console.log("  " + formatLaneLine(report));
      renderProjectReceipt(res, projectId, true);
    } else {
      log.success(`[${opts.type}] ${opts.claim.slice(0, 80)}`);
      log.dim(`  workspace: ${source}  id: ${String(res.id ?? "")}`);
      console.log("  " + formatLaneLine(report));
      renderProjectReceipt(res, projectId, false);
    }
  } catch (e) {
    renderHubError(e);
    process.exit(1);
  }
}

export async function provisionAgentWorkspace(
  opts: { agentUserId?: string; name?: string; use?: boolean; json?: boolean }
): Promise<void> {
  try {
    const cfg = await resolveHubConfig();
    const userId = await resolveUserId(cfg);
    const agentUserId = opts.agentUserId ?? userId;

    const res = await hubPost("/workspaces/provision-agent", {
      agentUserId,
      ...(opts.name ? { workspaceName: opts.name } : {}),
    }, cfg) as { workspaceId: string; created: boolean };

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    if (res.created) {
      log.success(`Agent workspace created: ${res.workspaceId}`);
    } else {
      log.info(`Agent workspace already exists: ${res.workspaceId}`);
    }

    if (opts.use ?? res.created) {
      const { setActiveWorkspaceId } = await import("../lib/pod.js");
      setActiveWorkspaceId(res.workspaceId);
      log.dim(`  Set as active workspace (synap use ${res.workspaceId})`);
    }
  } catch (e) {
    renderHubError(e);
    process.exit(1);
  }
}
