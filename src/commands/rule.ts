/**
 * synap rule — the fourth door.
 *
 * `ask` recalls, `capture` writes a fact, `diagnose` inspects. `rule` states a
 * STANDING instruction: something that should keep holding, not something to do
 * once.
 *
 * WHAT THIS DOOR DOES NOT DO — and deliberately never pretends to:
 * synthesising the BEHAVIOUR half (an automation flow) from a sentence needs an
 * agent, and that is not this wave. This command classifies the sentence, shows
 * the reading (including the literal cues that fired, so an AI-authored routing
 * is inspectable rather than oracular), refuses to guess when the classifier
 * asks for clarification, creates the rule RECORD through the governed door,
 * and then says plainly that no behaviour is attached yet. `synap automate`
 * remains the door that builds behaviour.
 *
 * The expensive failure this command exists to prevent is materialising a
 * ONE-OFF request ("we're working on Stellar Grants — research the process")
 * as a permanent rule. The classifier flags it; we stop and ask.
 */

import chalk from "chalk";
import prompts from "prompts";
import { log } from "../utils/logger.js";
import { renderNextSteps, type NextStep } from "../lib/next-steps.js";
import {
  resolveHubConfig,
  hubGet,
  hubPost,
  HubError,
  type HubConfig,
} from "../lib/hub-client.js";

// ── The classifier's contract, as the CLI consumes it ────────────────────────
// Mirrors `IntentRoute` from
// synap-backend/packages/api/src/services/knowledge/classify-intent.ts.
// The CLI does NOT re-implement the classifier — it is a pure function that
// lives on the pod, and forking 685 lines of heuristics into a published npm
// package would give the product two disagreeing readings of the same sentence.

export type RuleShape =
  | "fact"
  | "behaviour"
  | "structure"
  | "schedule"
  | "notification"
  | "extraction"
  | "unknown";

export interface ShapeMatch {
  shape: RuleShape;
  confidence: number;
  cues: string[];
}

export interface IntentRoute {
  shapes: ShapeMatch[];
  primary: RuleShape;
  oneShot: boolean;
  needsClarification?: { reason: string; question: string };
}

export type RuleScopeKind = "pod" | "workspace" | "user";

export interface CreateRuleResult {
  status: "created" | "proposed" | "denied";
  ruleId?: string;
  proposalId?: string;
  reason?: string;
}

/**
 * One row of `GET /api/hub/rules`. The door types `rule` as an open record
 * (it is the stored `metadata.rule` blob), so every field read off it is
 * treated as optional here rather than assumed present.
 */
export interface RuleRow {
  id: string;
  name: string;
  /** Nullable on the wire — `null` means not yet approved, same as `false`. */
  approved: boolean | null;
  /**
   * `"active"` = a real rule row on the pod. `"proposed"` = the rule exists
   * ONLY as a pending proposal and is not in effect yet. Optional because an
   * older pod does not send it; absent is read as `"active"`, which is what
   * every row from such a pod is.
   */
  status?: "active" | "proposed";
  /** Present on a `"proposed"` row — `synap open proposal <id>` reviews it. */
  proposalId?: string;
  workspaceId?: string | null;
  createdAt?: string;
  /**
   * The rule's automations, from the pod's `activates` EDGE — the membership
   * store. Optional because a pod older than that projection sends none; see
   * `behaviourCountOf` for how that case degrades.
   */
  automationIds?: string[];
  rule: {
    intent: string;
    scope: { kind: RuleScopeKind; workspaceId?: string };
    trust?: "propose" | "auto";
    factSkillId?: string;
    /**
     * ⚠️ NOT the membership store. `behaviours[]` now holds only the divergence
     * `flowHash`, keyed by automation id. Counting it was how the CLI and the
     * browser came to disagree about the same rule: the browser asks the pod
     * (which reads the edge) and this counted the JSONB, so a rule with an edge
     * but no snapshot read `0 attached` here and `1` there. Read
     * `automationIds` above; this stays only for the fallback.
     */
    behaviours?: { automationId: string }[];
  };
}

/**
 * How many automations this rule activates.
 *
 * Prefers the pod's edge-derived projection and falls back to the JSONB only
 * when the field is ABSENT — an older pod — never when it is an empty array,
 * which is a real answer meaning "no behaviour". Coalescing those two would
 * resurrect the divergence this function exists to end.
 */
function behaviourCountOf(r: RuleRow): number {
  return r.automationIds !== undefined
    ? r.automationIds.length
    : (r.rule.behaviours?.length ?? 0);
}

/**
 * The classify door is not deployed on the pod we are talking to. This is a
 * distinct outcome from "the pod said no": we refuse to write a rule we could
 * not read, so this fails CLOSED rather than falling back to a blind create.
 */
export class ClassifyDoorMissingError extends Error {
  constructor(readonly door: string) {
    // User-facing sentence first, route second. "no rule-intent classifier
    // door" named an internal component: true, and useless to someone deciding
    // what to do about it. The route stays in parentheses because this is a
    // terminal — the reader may well be the person who deploys the pod.
    super(`This pod can't read rules yet — it's running a build from before rules existed (${door} not found).`);
  }
}

/**
 * The door exists and the pod is current — this API KEY simply lacks the Bearer
 * scope. A third distinct cause, and it must never be reported as either of the
 * other two: "your pod is old" sends the user to an upgrade they don't need,
 * and "your sentence is ambiguous" sends them to rewrite a fine sentence.
 */
export class MissingScopeError extends Error {
  constructor(readonly scope: string) {
    super(`This API key lacks the \`${scope}\` scope.`);
  }
}

/** Discriminate the door's two different 403s by their body. */
function scopeErrorOrRethrow(err: unknown, scope: string): never {
  if (err instanceof HubError && err.status === 403) {
    throw new MissingScopeError(scope);
  }
  throw err;
}

export interface RuleDeps {
  classify: (text: string, cfg: HubConfig) => Promise<IntentRoute>;
  create: (
    input: {
      intent: string;
      scope: { kind: RuleScopeKind; workspaceId?: string };
    },
    cfg: HubConfig
  ) => Promise<CreateRuleResult>;
  list: (cfg: HubConfig, workspaceId?: string) => Promise<RuleRow[]>;
  config: (opts: { podUrl?: string; apiKey?: string }) => Promise<HubConfig>;
  confirm: (message: string) => Promise<boolean>;
}

// ── Transport: the Hub-REST rule doors ───────────────────────────────────────
// NOT `${podUrl}/trpc/skills.*`. Those are `protectedProcedure`, and
// `src/commands/automation.ts:118-131` documents that a `protectedProcedure`
// trips an identity-remap bug for API-key-authenticated CLI callers and answers
// a bare 403. The Hub-REST doors reach the same logic through
// `scopedProcedure`, which is API-key-native.
//
// Every door the CLI touches is named here and nowhere else, so a backend
// contract correction is a one-place change.
const CLASSIFY_DOOR = "POST /api/hub/rules/classify";

const liveDeps: RuleDeps = {
  // Body is `{ text, context? }` — the door takes NO workspaceId. `context`
  // (the pod's capability + profile slugs) is optional grounding that only
  // sharpens confidences and can never raise a shape on its own, so it is
  // deliberately not fetched: two extra round-trips before every `synap rule`
  // would buy nothing the verdict depends on.
  classify: async (text, cfg) => {
    try {
      return (await hubPost("/rules/classify", { text }, cfg)) as IntentRoute;
    } catch (err) {
      // A pod on an older build has no such route — a DIFFERENT outcome from
      // both "your sentence is ambiguous" and "your key lacks the scope".
      if (err instanceof HubError && err.status === 404) {
        throw new ClassifyDoorMissingError(CLASSIFY_DOOR);
      }
      scopeErrorOrRethrow(err, "hub-protocol.read");
    }
  },
  create: async (input, cfg) => {
    try {
      return (await hubPost("/rules", { ...input, automationIds: [] }, cfg)) as CreateRuleResult;
    } catch (err) {
      // The door answers a governance DENIAL with 403 + the verdict body
      // (`{ status:"denied", reason }`), and a missing Bearer scope with 403 +
      // `{ error }`. Same status, different causes — discriminate on the body,
      // and hand the denial back as the normal result it is.
      if (err instanceof HubError && err.status === 403) {
        const body = err.body as Record<string, unknown> | undefined;
        if (body?.status === "denied") {
          return {
            status: "denied",
            reason: String(body.reason ?? "no reason given"),
          };
        }
      }
      scopeErrorOrRethrow(err, "hub-protocol.write");
    }
  },
  // `includeProposed=true` is ALWAYS sent: this listing answers "what rules are
  // there", and a rule awaiting review is one of them. Without it the door
  // returns 0 straight after `synap rule "…"` proposes one, and the next reader
  // (human or agent) proposes the same rule again. Proposed rows arrive marked
  // (`status:"proposed"` + `proposalId`) and are rendered as pending, never
  // silently mixed in with rules that are actually in effect. An older pod
  // ignores the param and answers exactly as before.
  list: async (cfg, workspaceId) => {
    try {
      const res = (await hubGet(
        "/rules",
        { ...(workspaceId ? { workspaceId } : {}), includeProposed: "true" },
        cfg
      )) as { rules?: RuleRow[] };
      return res?.rules ?? [];
    } catch (err) {
      scopeErrorOrRethrow(err, "hub-protocol.read");
    }
  },
  config: (opts) => resolveHubConfig(opts),
  confirm: async (message) => {
    if (!process.stdin.isTTY) return false;
    const { ok } = await prompts({ type: "confirm", name: "ok", message, initial: false });
    return Boolean(ok);
  },
};

// ── Rendering ────────────────────────────────────────────────────────────────

const SHAPE_MEANING: Record<RuleShape, string> = {
  fact: "an instruction the agent should keep in mind",
  behaviour: "something that should happen automatically",
  structure: "how things should be organised",
  schedule: "something recurring on a clock",
  notification: "someone should be told",
  extraction: "data should be pulled out of something",
  unknown: "not recognisable as a standing rule",
};

/**
 * Show WHY it read the sentence that way. A routing the user cannot inspect is
 * exactly what this product refuses to ship, so the cues are printed beside
 * every shape — not just the verdict.
 *
 * Cues are human-readable LABELS, not necessarily substrings of the input
 * (some are synthetic, e.g. "identity attribute" / "capability: calendly"), so
 * they are printed as a `because:` list and never highlighted in the sentence.
 * `shapes` is never empty: the unclassifiable/one-off case arrives as a single
 * `unknown` entry, which still carries the cues that led there — so it is
 * rendered, not filtered away.
 */
function renderReading(route: IntentRoute): void {
  log.heading("  Understood as");
  const width = Math.max(...route.shapes.map((s) => s.shape.length));
  for (const s of route.shapes) {
    const label = s.shape.padEnd(width);
    const lead = s.shape === route.primary ? chalk.bold(label) : chalk.dim(label);
    // Confidences are numbers in a column — pad so the decimal points align.
    // Never rendered as a percentage: the classifier caps at 0.95 on purpose.
    const conf = s.confidence.toFixed(2).padStart(5);
    console.log(`    ${lead}  ${chalk.cyan(conf)}  ${chalk.dim(SHAPE_MEANING[s.shape])}`);
    if (s.cues.length > 0) {
      console.log(
        chalk.dim(`    ${" ".repeat(width)}         because: ${s.cues.join(", ")}`)
      );
    }
  }
}

function scopeLabel(scope: { kind: RuleScopeKind; workspaceId?: string }): string {
  return scope.kind === "workspace" && scope.workspaceId
    ? `workspace ${scope.workspaceId.slice(0, 8)}…`
    : scope.kind;
}

// ── `synap rule "<text>"` ────────────────────────────────────────────────────

export interface RuleOpts {
  workspace?: string;
  /** Force pod scope even when a workspace lens is active. */
  podWide?: boolean;
  json?: boolean;
  yes?: boolean;
  podUrl?: string;
  apiKey?: string;
}

export async function rule(
  text: string,
  opts: RuleOpts,
  deps: RuleDeps = liveDeps
): Promise<void> {
  const intent = text.trim();
  if (!intent) {
    console.error(
      chalk.red('Error: a rule is required. Usage: synap rule "your rule"')
    );
    process.exit(1);
    return;
  }

  let cfg: HubConfig;
  try {
    cfg = await deps.config({ podUrl: opts.podUrl, apiKey: opts.apiKey });
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
    return;
  }

  const workspaceId = opts.podWide ? undefined : (opts.workspace ?? cfg.workspaceId);
  const scope: { kind: RuleScopeKind; workspaceId?: string } = workspaceId
    ? { kind: "workspace", workspaceId }
    : { kind: "pod" };

  // 1. READ before writing. A rule we could not classify is a rule we refuse
  //    to create — nothing here falls back to a blind create.
  let route: IntentRoute;
  let classifyOutcome = "classify-failed";
  try {
    route = await deps.classify(intent, cfg);
  } catch (err) {
    if (err instanceof ClassifyDoorMissingError) {
      classifyOutcome = "classify-door-missing";
      log.error(err.message);
      log.hint(
        "This is your POD's build, not your sentence — update the pod, then retry."
      );
      log.hint("`synap rule` will not create a rule it could not read first.");
    } else if (err instanceof MissingScopeError) {
      classifyOutcome = "missing-scope";
      log.error(err.message);
      log.hint(
        "This is your API KEY, not your pod or your sentence — re-issue it with that scope:"
      );
      log.hint("  synap connect --target=<surface>");
    } else {
      log.error(err instanceof Error ? err.message : String(err));
    }
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, outcome: classifyOutcome, intent }, null, 2));
    }
    process.exit(1);
    return;
  }

  if (!opts.json) {
    log.heading("  Rule");
    log.dim(`"${intent}"`);
    renderReading(route);
    log.blank();
    console.log(chalk.dim(`    scope: ${scopeLabel(scope)}`));
  }

  // 2. Refuse to guess. `--yes` does NOT override this: the classifier is
  //    saying it cannot route the sentence, and skipping a confirmation is not
  //    the same as answering the question.
  if (route.needsClarification) {
    if (opts.json) {
      console.log(
        JSON.stringify(
          { ok: false, outcome: "needs-clarification", intent, route },
          null,
          2
        )
      );
    } else {
      log.blank();
      log.warn(`Ambiguous: ${route.needsClarification.reason}`);
      log.hint(route.needsClarification.question);
      log.hint(
        "Nothing was created — this is your sentence, not your pod. Re-run with a clearer one."
      );
    }
    process.exit(1);
    return;
  }

  // 3. A one-off request is not a rule. Creating a permanent rule from a
  //    one-shot ask is the expensive mistake — stop and confirm.
  if (route.oneShot) {
    if (opts.json && !opts.yes) {
      console.log(
        JSON.stringify(
          { ok: false, outcome: "one-shot-refused", intent, route },
          null,
          2
        )
      );
      process.exit(1);
      return;
    }
    if (!opts.json) {
      log.blank();
      log.warn("This reads as a ONE-OFF request, not a standing rule.");
      log.hint("A rule is permanent — it keeps applying. For a one-time job, ask the agent:");
      log.hint(`  synap ask "${intent}"`);
    }
    if (!opts.yes) {
      const confirmed = await deps.confirm("Create a permanent rule anyway?");
      if (!confirmed) {
        log.blank();
        log.info("No rule created.");
        renderNextSteps([
          { command: `synap ask "${intent}"`, why: "run this once instead of standing it up as a rule" },
          { command: "synap rule --yes \"<text>\"", why: "create it as a rule anyway" },
        ]);
        return;
      }
    }
  }

  // 4. Governed write. `proposed` is the normal agent outcome — a PR, not a
  //    failure — and is never rendered as an error.
  let result: CreateRuleResult;
  try {
    result = await deps.create({ intent, scope }, cfg);
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    if (err instanceof MissingScopeError) {
      log.hint("Re-issue the key with that scope:  synap connect --target=<surface>");
    }
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            ok: false,
            outcome: err instanceof MissingScopeError ? "missing-scope" : "create-failed",
            intent,
          },
          null,
          2
        )
      );
    }
    process.exit(1);
    return;
  }

  const nextSteps: NextStep[] = [];
  if (result.status === "proposed" && result.proposalId) {
    nextSteps.push({
      command: `synap open proposal ${result.proposalId}`,
      why: "review and approve the rule",
    });
  }
  nextSteps.push({
    command: `synap automate "${intent}"`,
    why: "build the behaviour half — this door records the rule only",
  });
  nextSteps.push({ command: "synap rule list", why: "see every rule and what is attached" });

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok: result.status !== "denied",
          outcome: result.status,
          intent,
          scope,
          route,
          ...(result.ruleId ? { ruleId: result.ruleId } : {}),
          ...(result.proposalId ? { proposalId: result.proposalId } : {}),
          ...(result.reason ? { reason: result.reason } : {}),
          // Honest about the half that does not exist yet.
          behaviourAttached: false,
          nextSteps,
        },
        null,
        2
      )
    );
    if (result.status === "denied") process.exit(1);
    return;
  }

  log.blank();
  if (result.status === "denied") {
    log.error(`Rule refused: ${result.reason ?? "no reason given"}`);
    process.exit(1);
    return;
  }
  if (result.status === "proposed") {
    log.info("Rule — proposed (queued for your review)");
    if (result.proposalId) log.dim(`  proposal: ${result.proposalId}`);
  } else {
    log.success(`Rule created${result.ruleId ? "  " + chalk.dim(result.ruleId) : ""}`);
  }
  log.warn(
    "No behaviour attached yet — this door records the rule, it does not build the automation."
  );
  renderNextSteps(nextSteps);
}

// ── `synap rule list` ────────────────────────────────────────────────────────

export interface RuleListOpts {
  workspace?: string;
  json?: boolean;
  podUrl?: string;
  apiKey?: string;
}

export async function ruleList(
  opts: RuleListOpts,
  deps: RuleDeps = liveDeps
): Promise<void> {
  let cfg: HubConfig;
  let rows: RuleRow[];
  try {
    cfg = await deps.config({ podUrl: opts.podUrl, apiKey: opts.apiKey });
    rows = await deps.list(cfg, opts.workspace ?? cfg.workspaceId);
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    if (err instanceof MissingScopeError) {
      log.hint("Re-issue the key with that scope:  synap connect --target=<surface>");
    }
    process.exit(1);
    return;
  }

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          count: rows.length,
          rules: rows.map((r) => ({
            id: r.id,
            name: r.name,
            approved: r.approved,
            // A pod that predates the proposed-rule read sends no `status`;
            // every row it returns IS a materialized rule.
            status: r.status ?? "active",
            ...(r.proposalId ? { proposalId: r.proposalId } : {}),
            intent: r.rule.intent,
            scope: r.rule.scope,
            trust: r.rule.trust,
            behaviourCount: behaviourCountOf(r),
            behaviourAttached: behaviourCountOf(r) > 0,
          })),
        },
        null,
        2
      )
    );
    return;
  }

  log.heading(`  Rules  ${chalk.cyan(String(rows.length))}`);
  if (rows.length === 0) {
    log.dim("none yet");
    renderNextSteps([
      { command: 'synap rule "<your rule>"', why: "state a standing rule in plain language" },
    ]);
    return;
  }

  const intents = rows.map((r) => r.rule.intent);
  const intentWidth = Math.min(56, Math.max(...intents.map((i) => i.length)));
  const scopes = rows.map((r) => scopeLabel(r.rule.scope));
  const scopeWidth = Math.max(...scopes.map((s) => s.length));

  for (const [i, r] of rows.entries()) {
    // Three states, not two. A PROPOSED rule does not exist on the pod yet —
    // collapsing it into "awaiting review" (which an unapproved but REAL row
    // also is) would hide that nothing was written.
    const proposed = r.status === "proposed";
    const badge = proposed
      ? chalk.magenta("◇")
      : r.approved
        ? chalk.green("●")
        : chalk.yellow("○");
    const intent =
      intents[i].length > intentWidth
        ? intents[i].slice(0, intentWidth - 1) + "…"
        : intents[i].padEnd(intentWidth);
    const count = behaviourCountOf(r);
    // Counts are a column — pad the PLAIN text, then colour, so ANSI codes
    // never enter the width arithmetic.
    const plain =
      count > 0
        ? `${String(count).padStart(2)} automation${count === 1 ? "" : "s"}`
        : " — no behaviour";
    const behaviour = count > 0 ? chalk.green(plain.padEnd(14)) : chalk.dim(plain.padEnd(14));
    // A proposed rule's own id is not addressable yet — show the PROPOSAL id,
    // which is the only id that opens anything (`synap open proposal <id>`).
    const trailingId = proposed
      ? chalk.magenta(`proposal ${(r.proposalId ?? "").slice(0, 8)}…`)
      : chalk.dim(r.id.slice(0, 8) + "…");
    console.log(
      `  ${badge}  ${intent}  ${chalk.dim(scopes[i].padEnd(scopeWidth))}  ${behaviour}  ${trailingId}`
    );
  }
  log.blank();
  console.log(
    chalk.dim(
      `    ${chalk.green("●")} approved   ${chalk.yellow("○")} awaiting review   ${chalk.magenta("◇")} proposed — not written yet`
    )
  );
  renderNextSteps([
    { command: "synap open proposal <id>", why: "approve a rule that is awaiting review" },
    { command: 'synap automate "<rule>"', why: "build the behaviour half for a rule that has none" },
  ]);
}
