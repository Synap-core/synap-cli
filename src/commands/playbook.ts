/**
 * `synap playbook run <name|id>` — start a governed process in one step
 * (Hub `POST /api/hub/playbooks/:id/run`, the door MCP `synap_run_playbook`
 * shares via `runPlaybookDoor`).
 *
 *   synap playbook run "Design to implementation" --subject <entityId> --param goal="..."
 *
 * Name → id resolves through `GET /playbooks` (the user floor); an ambiguous
 * name is refused with its candidates, never a silent pick. Params are typed
 * against the playbook's DECLARED params. The door itself never refuses a
 * missing required param (headless door: it files an OWED slot for the person),
 * so this command says so up front instead of inventing a stricter rule.
 * `proposed` is SUCCESS (an agent's run is usually a proposal): the review link
 * is printed and the exit is 0. 401/403 and every other non-2xx go through
 * `renderHubError` (the key-state hint pattern) and exit non-zero.
 */

import chalk from "chalk";
import { log } from "../utils/logger.js";
import {
  resolveHubConfig,
  hubGet,
  hubPost,
  renderHubError,
} from "../lib/hub-client.js";
import { type BaseOpts } from "./data.js";

type Json = Record<string, unknown>;

interface DeclaredParam {
  name: string;
  type?: string;
  options?: unknown[];
  required?: boolean;
}

interface PlaybookRow {
  id: string;
  name: string;
  workspaceId?: string | null;
  params?: unknown;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A refusal: the command's own precondition failed, nothing was sent. */
class Refusal extends Error {}

function declaredParams(row: PlaybookRow): DeclaredParam[] {
  return Array.isArray(row.params)
    ? (row.params as unknown[]).filter(
        (p): p is DeclaredParam =>
          typeof p === "object" && p !== null && typeof (p as DeclaredParam).name === "string"
      )
    : [];
}

function describeParams(decl: DeclaredParam[]): string {
  return decl
    .map((d) => `${d.name} (${d.type ?? "text"}${d.required ? ", required" : ""})`)
    .join(", ");
}

/** Resolve a name or id to one playbook row. Unknown or ambiguous = refuse. */
export async function resolvePlaybook(
  ref: string,
  cfg: Parameters<typeof hubGet>[2]
): Promise<PlaybookRow> {
  if (UUID_RE.test(ref)) {
    // A 404 is a HubError — renderHubError prints it with the server's message.
    return (await hubGet(`/playbooks/${encodeURIComponent(ref)}`, {}, cfg)) as PlaybookRow;
  }
  const wanted = ref.trim().toLowerCase();
  const matches: PlaybookRow[] = [];
  let cursor: string | undefined;
  do {
    const page = (await hubGet(
      "/playbooks",
      { status: "active", limit: 100, cursor },
      cfg
    )) as { playbooks?: PlaybookRow[]; nextCursor?: string | null };
    for (const p of page.playbooks ?? []) {
      if (p.name.trim().toLowerCase() === wanted) matches.push(p);
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  if (matches.length === 0) {
    throw new Refusal(
      `No active playbook named "${ref}" among the playbooks this key can see. List them with: synap pod`
    );
  }
  if (matches.length > 1) {
    throw new Refusal(
      `"${ref}" matches ${matches.length} playbooks — pass the id of one:\n` +
        matches.map((m) => `    ${m.id}  ${m.name}${m.workspaceId ? `  (workspace ${m.workspaceId})` : "  (pod-wide)"}`).join("\n")
    );
  }
  return matches[0]!;
}

/** `key=value` pairs → params, typed by the playbook's declared params. */
export function typeParams(pairs: string[], decl: DeclaredParam[], playbookName: string): Json {
  const out: Json = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new Refusal(`Param "${pair}" is not key=value.`);
    const key = pair.slice(0, eq).trim();
    const raw = pair.slice(eq + 1);
    const d = decl.find((x) => x.name === key);
    if (!d) {
      throw new Refusal(
        decl.length
          ? `"${playbookName}" declares no param "${key}". Declared: ${describeParams(decl)}`
          : `"${playbookName}" declares no params, so --param ${key}=… has nowhere to go.`
      );
    }
    const type = d.type ?? "text";
    if (type === "number") {
      const n = Number(raw);
      if (raw.trim() === "" || !Number.isFinite(n)) throw new Refusal(`Param ${key} is a number — got "${raw}".`);
      out[key] = n;
    } else if (type === "boolean") {
      if (raw !== "true" && raw !== "false") throw new Refusal(`Param ${key} is a boolean — use true or false, got "${raw}".`);
      out[key] = raw === "true";
    } else if (type === "entity") {
      if (!UUID_RE.test(raw)) throw new Refusal(`Param ${key} is an entity — pass its id (uuid), got "${raw}".`);
      out[key] = raw;
    } else if (type === "choice") {
      const opts = (d.options ?? []).map((o) => (typeof o === "string" ? o : String((o as Json)?.value ?? (o as Json)?.key ?? o)));
      if (opts.length && !opts.includes(raw)) throw new Refusal(`Param ${key} must be one of: ${opts.join(", ")} — got "${raw}".`);
      out[key] = raw;
    } else {
      out[key] = raw;
    }
  }
  return out;
}

export async function runPlaybook(
  ref: string,
  opts: BaseOpts & { subject?: string; param?: string[]; reason?: string; workspace?: string }
): Promise<void> {
  try {
    if (opts.subject && !UUID_RE.test(opts.subject)) {
      throw new Refusal(`--subject must be an entity id (uuid), got "${opts.subject}".`);
    }
    const cfg = await resolveHubConfig(opts);
    const pb = await resolvePlaybook(ref, cfg);
    const decl = declaredParams(pb);
    const params = typeParams(opts.param ?? [], decl, pb.name);

    const missing = decl.filter((d) => d.required && !(d.name in params));
    if (missing.length && !opts.json) {
      log.warn(
        `Required param(s) not given: ${missing.map((m) => m.name).join(", ")} — the run will ask you for them.`
      );
    }

    const body: Json = {};
    if (opts.subject) body.subjectId = opts.subject;
    if (Object.keys(params).length) body.params = params;
    if (opts.reason) body.reasoning = opts.reason;
    if (opts.workspace) body.workspaceId = opts.workspace;
    const r = (await hubPost(`/playbooks/${encodeURIComponent(pb.id)}/run`, body, cfg)) as Json;

    if (opts.json) console.log(JSON.stringify(r, null, 2));

    if (r.status === "proposed" && typeof r.proposalId === "string") {
      if (!opts.json) {
        log.warn(`Running "${pb.name}" is queued for your review — not started yet.`);
        if (typeof r.reviewUrl === "string") log.hint(`Review: ${r.reviewUrl}`);
        log.hint(`Or: synap open proposal ${r.proposalId}`);
      }
      return;
    }
    if (r.status === "draft") {
      if (!opts.json) {
        const session = r.session as { id?: string } | null | undefined;
        log.warn(`"${pb.name}" is waiting as a draft — it does not start until you accept it.`);
        if (session?.id) log.hint(`Accept it in your sessions: synap open session ${session.id}`);
      }
      return;
    }
    if (r.status === "blocked" || r.status === "skipped") {
      if (!opts.json) {
        log.error(typeof r.message === "string" ? r.message : `Nothing ran (${String(r.status)}).`);
      }
      process.exit(1);
      return;
    }
    if (!opts.json) {
      const session = r.session as { id?: string } | null | undefined;
      log.success(`Started: ${chalk.bold(pb.name)}`);
      if (session?.id) log.dim(`Session ${session.id} — follow it: synap session get ${session.id}`);
    }
  } catch (e) {
    if (e instanceof Refusal) {
      log.error(e.message);
    } else {
      renderHubError(e);
    }
    process.exit(1);
  }
}
