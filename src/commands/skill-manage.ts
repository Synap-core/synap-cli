/**
 * synap skill add / list / remove — manage instruction skills on the pod.
 *
 * Skills follow the Agent Skills open standard (SKILL.md directories), so users
 * can add skills from many sources — the bundled Synap-native set, a local
 * folder, their existing ~/.claude/skills/, or any GitHub repo — and the agent
 * loads them. One dedicated command, not buried in bridge-setup.
 */

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import chalk from "chalk";
import ora from "ora";
import { log } from "../utils/logger.js";
import {
  resolveHubConfig,
  resolveUserId,
  hubGet,
  hubPost,
  hubDelete,
  type HubConfig,
} from "../lib/hub-client.js";
import { unwrapList } from "../lib/unwrapList.js";
import {
  discoverSkillDirs,
  parseSkillDir,
  importSkill,
} from "../lib/skill-import.js";
import { resolveBundledSkillsDir } from "./bridge-setup.js";

interface SkillManageOpts {
  podUrl?: string;
  apiKey?: string;
}

/** Expand ~ and resolve a local path. */
function expandPath(p: string): string {
  if (p.startsWith("~")) return path.join(os.homedir(), p.slice(1));
  return path.resolve(p);
}

/** GitHub `owner/repo` (and `owner/repo/skill`) shorthand — no dots, no leading ./ or ~. */
function parseGitHubShorthand(
  source: string
): { repo: string; skill?: string; ref?: string } | null {
  if (source.startsWith(".") || source.startsWith("/") || source.startsWith("~"))
    return null;
  if (source.startsWith("http") || source.startsWith("git@")) return null;
  const [pathPart, ref] = source.split("@");
  const parts = pathPart.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return {
    repo: `${parts[0]}/${parts[1]}`,
    skill: parts.length > 2 ? parts.slice(2).join("/") : undefined,
    ref,
  };
}

/**
 * Resolve a source to a list of SKILL.md directories on local disk.
 * Returns { dirs, cleanup } — cleanup removes any temp clone.
 */
function resolveSource(source: string): { dirs: string[]; cleanup?: () => void } {
  // 1. Bundled Synap-native skills
  if (source === "bundled" || source === "synap") {
    const dir = resolveBundledSkillsDir();
    if (!dir) throw new Error("Bundled skills not found in this CLI install");
    return { dirs: discoverSkillDirs(dir) };
  }

  // 2. Local path (incl. ~/.claude/skills/)
  if (source.startsWith(".") || source.startsWith("/") || source.startsWith("~")) {
    const abs = expandPath(source);
    if (!fs.existsSync(abs)) throw new Error(`Path not found: ${abs}`);
    return { dirs: discoverSkillDirs(abs) };
  }

  // 3. GitHub shorthand or full git URL → shallow clone to a temp dir
  const gh = parseGitHubShorthand(source);
  const cloneUrl = gh
    ? `https://github.com/${gh.repo}.git`
    : source.startsWith("http") || source.startsWith("git@")
      ? source
      : null;
  if (cloneUrl) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "synap-skill-"));
    const args = ["clone", "--depth", "1"];
    if (gh?.ref) args.push("--branch", gh.ref);
    args.push(cloneUrl, tmp);
    try {
      execFileSync("git", args, { stdio: "pipe" });
    } catch (err) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw new Error(`git clone failed: ${(err as Error).message}`);
    }
    const root = gh?.skill ? path.join(tmp, gh.skill) : tmp;
    return {
      dirs: discoverSkillDirs(root),
      cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
    };
  }

  throw new Error(
    `Unrecognized source "${source}". Use: bundled · a local path · ~/.claude/skills/ · owner/repo · a git URL.`
  );
}

/** synap skill add <source> */
export async function addSkill(
  source: string,
  opts: SkillManageOpts
): Promise<void> {
  const cfg = await resolveHubConfig(opts);
  const userId = await resolveUserId(cfg);

  let resolved: { dirs: string[]; cleanup?: () => void };
  try {
    resolved = resolveSource(source);
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }

  if (resolved.dirs.length === 0) {
    log.warn(`No SKILL.md skill directories found in "${source}".`);
    resolved.cleanup?.();
    return;
  }

  const spinner = ora(`Importing ${resolved.dirs.length} skill(s)…`).start();
  let imported = 0,
    existed = 0,
    errored = 0;
  const lines: string[] = [];

  for (const dir of resolved.dirs) {
    const parsed = parseSkillDir(dir);
    if (!parsed) continue;
    const res = await importSkill(parsed, userId, cfg);
    if (res.status === "imported") {
      imported++;
      lines.push(
        `  ${chalk.green("✓")} ${parsed.slug}${res.docs ? chalk.dim(` · ${res.docs} docs`) : ""}${parsed.autoLoad ? chalk.dim(" · core") : ""}`
      );
    } else if (res.status === "exists") {
      existed++;
      lines.push(`  ${chalk.dim("•")} ${chalk.dim(parsed.slug + " (already on pod)")}`);
    } else {
      errored++;
      lines.push(`  ${chalk.red("✗")} ${parsed.slug} — ${chalk.red(res.error ?? "error")}`);
    }
  }

  resolved.cleanup?.();
  spinner.stop();
  lines.forEach((l) => console.log(l));
  log.success(
    `Added ${imported} skill(s)${existed ? `, ${existed} already present` : ""}${errored ? chalk.red(`, ${errored} failed`) : ""}.`
  );
}

/** synap skill list */
export async function listSkills(opts: SkillManageOpts & { debug?: boolean }): Promise<void> {
  const cfg = await resolveHubConfig(opts);
  if (opts.debug) log.dim(`key prefix: ${cfg.apiKey.slice(0, 16)}...  userId: ${cfg.userId}  pod: ${cfg.podUrl}`);

  // Resolve the operator userId from the key context. The executable route
  // returns ALL pod-scoped skills regardless of userId, but the scope filter
  // in the tRPC procedure uses the ACTING userId from the key context.
  // We send the userId explicitly so the filter includes user-scoped skills
  // matching the resolved user, not just pod-scoped ones.
  const userId = await resolveUserId(cfg);
  // `approved` is DELIBERATELY omitted: the route treats an absent param as
  // "no filter" (`agent-skills.ts:276-278`), so this returns approved AND
  // awaiting-approval skills. It used to hardcode `&approved=true`, which made
  // an unapproved skill invisible here — and since `load_skill` also requires
  // `approved`, `list_capabilities` excludes teaching docs, and a directly
  // created skill is never a proposal, an agent-authored skill awaiting its
  // owner had NO surface anywhere on the pod. The approval gate is only real
  // if the thing awaiting approval can be seen.
  type WireSkill = {
    id?: string;
    /** The stable ref every other command takes. The route returns it; this
     *  local type simply omitted it, which is why the listing printed `name`. */
    slug?: string | null;
    name: string;
    description?: string | null;
    kind?: string;
    metadata?: { autoLoad?: boolean };
    body?: string | null;
    code?: string;
    approved?: boolean;
  };
  const res = (await hubGet(
    `/agent-skills/executable?userId=${encodeURIComponent(userId)}&status=active`,
    {},
    cfg
  )) as WireSkill[];
  const all = unwrapList<WireSkill>(res);
  // Absent `approved` means the row predates the flag / the route did not
  // project it — treat only an explicit `false` as pending, so a missing field
  // can never quarantine a working skill.
  const pending = all.filter((s) => s.approved === false);
  const skills = all.filter((s) => s.approved !== false);
  const core = skills.filter((s) => s.metadata?.autoLoad === true);
  const onDemand = skills.filter((s) => s.metadata?.autoLoad !== true);

  if (all.length === 0) {
    log.dim("No skills on the pod yet. Add some: synap skill add bundled");
    return;
  }

  const summary =
    `${skills.length} total (${core.length} core auto-load, ${onDemand.length} on-demand)` +
    (pending.length > 0 ? `, ${pending.length} awaiting approval` : "");
  console.log(chalk.bold(`\nSkills on your pod — ${summary}\n`));

  const print = (skills: typeof core, badge: string) => {
    for (const s of skills) {
      // Print the SLUG — it is the ref `load_skill` resolves and the ref
      // `skill approve/remove` takes. This line used to read
      // `const slug = s.name`: a variable named `slug` holding the NAME, so
      // the identifier a user copied off this listing was not one any other
      // command could resolve. Fall back to the name only when a row has no
      // slug (legacy rows predate the column).
      const slug = s.slug ?? s.name;
      const kind = s.kind ?? (s.body ? "instruction" : s.code ? "code" : "?");
      const desc = s.description?.slice(0, 120) ?? "";
      console.log(`  ${chalk.cyan(slug.padEnd(42))} ${chalk.dim(kind)}  ${badge}`);
      if (desc) console.log(`  ${" ".repeat(42)} ${chalk.dim(desc)}`);
    }
  };

  if (core.length > 0) {
    console.log(chalk.bold("Core (auto-injected every turn)"));
    print(core, chalk.green("● core"));
  }
  if (onDemand.length > 0) {
    if (core.length > 0) console.log("");
    console.log(chalk.bold("On-demand (catalog — agent calls load_skill when relevant)"));
    print(onDemand, chalk.yellow("○ on-demand"));
  }

  // Awaiting approval — the section that did not exist. An agent-authored
  // skill is born unapproved on purpose (its body lands in a future agent's
  // system prompt, so prose is a prompt-injection vector exactly as code is an
  // execution one). It does NOT load until the owner approves, so the owner
  // has to be able to find it and be told where to act.
  if (pending.length > 0) {
    if (core.length > 0 || onDemand.length > 0) console.log("");
    console.log(
      chalk.bold("Awaiting your approval (will NOT load until approved)")
    );
    for (const s of pending) {
      const kind = s.kind ?? (s.body ? "instruction" : s.code ? "code" : "?");
      const desc = s.description?.slice(0, 120) ?? "";
      console.log(
        `  ${chalk.cyan(s.name.padEnd(42))} ${chalk.dim(kind)}  ${chalk.red("● pending")}`
      );
      if (desc) console.log(`  ${" ".repeat(42)} ${chalk.dim(desc)}`);
      // Point at the CLI door, NOT `${podUrl}/open/<id>`. That deep link is a
      // proposal-review path; for an instruction skill the browser resolves it
      // through the owning verb and lands on an empty catalog — a link that
      // silently does nothing is worse than no link.
      console.log(
        `  ${" ".repeat(42)} ${chalk.dim(`approve: synap skill approve ${s.id ?? s.name}`)}`
      );
    }
  }
  console.log("");
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Server-side cap on `GET /skills` (`skills-crud.ts`: `Math.min(…, 100)`). */
const MANAGEMENT_LIST_CAP = 100;

/**
 * Resolve a user-supplied slug / name / id to a skill id, for MANAGEMENT.
 *
 * Deliberately NOT `GET /agent-skills/by-slug/:slug`. That route is an external
 * READ surface and filters `kind='instruction' AND status='active' AND
 * approved=true` (`rest/agent-skills.ts:490-495`) — a floor that
 * `agent-skills.visibility.tripwire.test.ts` exists to protect, because a live
 * agent consumer reads it and unapproved prose must never reach an agent's
 * context. So an UNAPPROVED skill — the only kind anyone ever needs to
 * *approve* — is invisible there by design.
 *
 * `GET /skills` is the management sibling of `POST /skills/:id/approve` and
 * `DELETE /skills/:id`, applies no approval filter, and returns `id` + `slug`.
 *
 * (The slash in a hierarchical slug was never the problem: Hono routes on the
 * raw pathname, so `encodeURIComponent` makes `%2F` a literal char and the
 * exact match succeeds. The approval floor was always the blocker.)
 */
async function resolveSkillIdForManagement(
  ref: string,
  cfg: HubConfig
): Promise<string | null> {
  if (UUID_RE.test(ref)) return ref;

  const res = await hubGet(
    "/skills",
    { limit: MANAGEMENT_LIST_CAP },
    cfg
  );
  // `skillsRouter.list` returns `{ skills: [...] }` — the legacy-key hint is
  // REQUIRED. Without it `unwrapList` finds no array and returns [], which
  // reads downstream as "no such skill" rather than "I looked in the wrong
  // place". That is the silent-empty-read defect, and it was written here.
  const rows = unwrapList<{ id?: string; slug?: string | null; name?: string }>(
    res as never,
    ["skills"]
  );
  // Slug first — it is the stable ref. Name is a courtesy fallback because
  // `skill list` has historically PRINTED the name under a "slug" heading.
  const hit =
    rows.find((s) => s.slug === ref) ?? rows.find((s) => s.name === ref);
  if (hit?.id) return hit.id;

  // HONEST MISS: a capped listing that found nothing has NOT proven absence.
  // Saying "no such skill" here would be the same lie as a scoped-empty read
  // reported as "none exist".
  if (rows.length >= MANAGEMENT_LIST_CAP) {
    log.error(
      `No skill matched "${ref}" within the first ${MANAGEMENT_LIST_CAP} skills — ` +
        "the server caps this listing, so this is NOT proof it does not exist."
    );
    log.dim("Pass the skill id instead — `synap skill list` prints it.");
    return null;
  }
  log.error(`No skill found with slug, name or id "${ref}".`);
  return null;
}

/**
 * synap skill approve <slug-or-id>  (and `--revoke` for the inverse)
 *
 * The human half of the draft→approve→load gate. An agent-authored skill is
 * born UNAPPROVED on purpose — a code skill executes, and an `instruction`
 * skill's prose lands in a future agent's system prompt, so both need a
 * deliberate owner OK before they run or load.
 *
 * Until now that gate had no usable door: the browser's only skill surface is
 * the Capabilities app, which resolves a skill through the VERB that owns it
 * (`buildFocusStack`), so an instruction skill — which is a teaching doc, not
 * a verb — resolved to nothing and landed on an empty catalog. A gate whose
 * approval step cannot be reached is not a gate, it is a dead end.
 *
 * This does NOT widen anyone's authority: `POST /skills/:id/approve` is
 * owner/pod-admin gated server-side, so an agent key is refused there exactly
 * as it was before. It adds the door; the server still decides.
 */
export async function approveSkill(
  ref: string,
  opts: SkillManageOpts & { revoke?: boolean }
): Promise<void> {
  const cfg = await resolveHubConfig(opts);
  const approved = !opts.revoke;

  // Accept a raw id, a slug, or the name — a user should not have to know
  // which one they are holding. Resolution goes through the MANAGEMENT door;
  // see `resolveSkillIdForManagement` for why not `by-slug`.
  const id = await resolveSkillIdForManagement(ref, cfg);
  if (!id) return; // helper already reported why, honestly

  try {
    await hubPost(`/skills/${id}/approve`, { approved }, cfg);
  } catch (err) {
    // Name the likely cause instead of echoing a bare status: this endpoint is
    // owner/pod-admin gated, and an agent key being refused here is the
    // designed behaviour, not a malfunction.
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Could not ${approved ? "approve" : "revoke"} skill: ${msg}`);
    log.dim(
      "This door is owner/pod-admin only. If your active key is an agent key, " +
        "approve as yourself (synap whoami shows the winning key and its pod)."
    );
    return;
  }

  log.success(
    approved
      ? `Approved "${ref}" — it will now load via load_skill.`
      : `Revoked approval for "${ref}" — it will no longer load.`
  );
}

/** synap skill remove <slug> */
export async function removeSkill(
  slug: string,
  opts: SkillManageOpts
): Promise<void> {
  const cfg = await resolveHubConfig(opts);
  // Same management door as `approveSkill` — removing a skill you have not
  // approved is exactly as legitimate as approving it, and the read surface
  // cannot see either.
  const id = await resolveSkillIdForManagement(slug, cfg);
  if (!id) process.exit(1);
  await hubDelete(`/agent-skills/${id}`, cfg);
  log.success(`Removed skill "${slug}".`);
}
