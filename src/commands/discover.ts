/**
 * synap discover
 *
 * Runtime discovery for AI agents: fetches ground-truth entity profiles
 * (with property schemas) and the canonical CLI command tree from the pod.
 *
 * Replaces static skill file profile descriptions — agents call this once
 * per session to get current schema including any custom workspace profiles.
 */

import chalk from "chalk";
import { log } from "../utils/logger.js";
import { resolveHubConfig, resolveUserId, hubGet, renderHubError } from "../lib/hub-client.js";

interface DiscoverProperty {
  slug: string;
  displayName: string;
  type: string;
  options?: string[];
  required?: boolean;
}

interface DiscoverProfile {
  slug: string;
  displayName: string;
  scope: "pod" | "workspace";
  description?: string | null;
  properties?: DiscoverProperty[];
  createCommand?: string;
  /** 'kind' = a primary entity type (person, task, …); 'role' = a hat an
   *  existing entity can wear (client, partner, …) via `synap facet attach` —
   *  never created as its own entity. */
  profileKind?: "kind" | "role";
  /** For a role profile: which kinds it can attach to (e.g. ["person", "company"]). */
  applicableKinds?: string[];
}

interface DiscoverResult {
  profiles: DiscoverProfile[];
  commands: Record<string, string>;
  hint: string;
}

export interface DiscoverOpts {
  podUrl?: string;
  apiKey?: string;
  workspace?: string;
  json?: boolean;
  profiles?: boolean;
  commands?: boolean;
  summary?: boolean;
  profileSlugs?: string;
}

export async function discover(opts: DiscoverOpts): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const userId = await resolveUserId(cfg);
    const workspaceId = opts.workspace ?? cfg.workspaceId;

    if (!workspaceId) {
      console.error(chalk.red("No workspace set. Run: synap use <workspace-id>"));
      process.exit(1);
    }

    const profileSlugs = opts.profileSlugs
      ?.split(",")
      .map((slug) => slug.trim())
      .filter(Boolean);
    const res = (await hubGet(
      "/discover",
      {
        userId,
        workspaceId,
        ...(opts.summary ? { summary: "true" } : {}),
        ...(profileSlugs?.length ? { profileSlugs: profileSlugs.join(",") } : {}),
      },
      cfg
    )) as DiscoverResult;

    // JSON mode — dump everything (or filtered slice)
    if (opts.json) {
      if (opts.profiles) {
        console.log(JSON.stringify({ profiles: res.profiles }, null, 2));
      } else if (opts.commands) {
        console.log(JSON.stringify({ commands: res.commands }, null, 2));
      } else {
        console.log(JSON.stringify(res, null, 2));
      }
      return;
    }

    // Human-readable output
    if (!opts.commands) {
      log.heading(`Entity profiles (${res.profiles.length})`);
      for (const p of res.profiles) {
        const scope = p.scope === "pod" ? chalk.cyan("pod-wide") : chalk.yellow("workspace");
        // A role-profile is never its own entity — it's a hat an existing
        // entity can wear (attach via `synap facet attach`). Label it
        // distinctly so it never reads like a primary kind.
        const kindLabel = p.profileKind === "role"
          ? chalk.magenta(`[Role${p.applicableKinds?.length ? ` of ${p.applicableKinds.join("/")}` : ""}]`)
          : chalk.green("[Kind]");
        console.log(`\n  ${chalk.bold(p.slug)} ${chalk.dim("·")} ${p.displayName} ${kindLabel} ${chalk.dim(`[${scope}]`)}`);
        if (p.description) console.log(`    ${chalk.dim(p.description)}`);
        if ((p.properties?.length ?? 0) > 0) {
          for (const prop of p.properties ?? []) {
            const opts_str = prop.options?.length ? chalk.dim(` (${prop.options.join("|")})`) : "";
            const req = prop.required ? chalk.red("*") : "";
            console.log(`    ${chalk.dim("·")} ${prop.slug}${req}: ${chalk.dim(prop.type)}${opts_str}`);
          }
        } else if (!opts.summary) {
          console.log(`    ${chalk.dim("(no typed properties)")}`);
        }
        if (p.createCommand) {
          console.log(`    ${chalk.dim("→")} ${chalk.dim(p.createCommand)}`);
        }
      }
    }

    if (!opts.profiles) {
      console.log();
      log.heading("Commands");
      for (const [name, cmd] of Object.entries(res.commands)) {
        console.log(`  ${chalk.cyan(name.padEnd(18))} ${chalk.dim(cmd)}`);
      }
    }

    console.log(`\n${chalk.dim(res.hint)}`);
  } catch (e) {
    renderHubError(e);
    process.exit(1);
  }
}
