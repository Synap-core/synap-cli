import chalk from "chalk";
import { log } from "../utils/logger.js";
import { resolveHubConfig, resolveUserId, hubGet, hubPost, hubPatch } from "../lib/hub-client.js";

interface BaseOpts {
  json?: boolean;
  podUrl?: string;
  apiKey?: string;
}

// ─── orient ───────────────────────────────────────────────────────────────────

export async function orient(opts: BaseOpts): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const [workspacesRes, meRes] = await Promise.all([
      hubGet("/workspaces", {}, cfg),
      hubGet("/users/me", {}, cfg),
    ]);
    const workspaces = (workspacesRes as { workspaces?: unknown[] }).workspaces ?? (workspacesRes as unknown[]);
    const me = meRes as Record<string, unknown>;
    const userId = String(me.id ?? cfg.userId);
    const wsList = Array.isArray(workspaces) ? workspaces as Record<string, unknown>[] : [];

    // For each workspace, fetch profiles + entity count in parallel
    const wsDetails = await Promise.all(
      wsList.map(async (ws) => {
        const wsId = String(ws.id ?? "");
        const [profilesRes, entitiesRes] = await Promise.allSettled([
          hubGet("/profiles", { userId, workspaceId: wsId }, cfg),
          hubGet("/entities", { userId, workspaceId: wsId, limit: 1 }, cfg),
        ]);
        const profiles = profilesRes.status === "fulfilled"
          ? ((profilesRes.value as { profiles?: unknown[] }).profiles ?? (profilesRes.value as unknown[]))
          : [];
        const profileList = Array.isArray(profiles) ? profiles as Record<string, unknown>[] : [];
        const entityTotal = entitiesRes.status === "fulfilled"
          ? Number((entitiesRes.value as Record<string, unknown>).total ?? 0)
          : 0;
        return { ws, profileList, entityTotal };
      })
    );

    if (opts.json) {
      console.log(JSON.stringify({ userId, podUrl: cfg.podUrl, workspaceId: cfg.workspaceId, workspaces: wsDetails, me }, null, 2));
      return;
    }

    log.heading("Pod Orientation");
    log.info(`User     : ${String(me.email ?? me.name ?? userId)}`);
    log.info(`Pod URL  : ${cfg.podUrl}`);
    if (cfg.workspaceId) log.info(`Workspace: ${cfg.workspaceId} ${chalk.dim("(active — use 'synap use <id>' to change)")}`);
    log.blank();
    log.heading("Workspaces");
    if (wsDetails.length === 0) {
      log.dim("No workspaces found.");
    } else {
      for (const { ws, profileList, entityTotal } of wsDetails) {
        const isActive = ws.id === cfg.workspaceId;
        const marker = isActive ? chalk.green("▶ ") : "  ";
        const name = chalk.bold(String(ws.name ?? ws.id));
        const id = chalk.dim(String(ws.id ?? "").slice(0, 8) + "…");
        const count = entityTotal > 0 ? chalk.dim(`${entityTotal} entities`) : chalk.dim("empty");
        log.info(`${marker}${name}  ${id}  ${count}`);
        if (ws.description) log.dim(`     ${String(ws.description)}`);
        if (profileList.length > 0) {
          const slugs = profileList
            .map((p) => String(p.slug ?? p.name ?? ""))
            .filter(Boolean)
            .slice(0, 8)
            .join(chalk.dim(", "));
          log.dim(`     profiles: ${slugs}${profileList.length > 8 ? chalk.dim(" …") : ""}`);
        }
      }
      if (!cfg.workspaceId) {
        log.blank();
        log.dim("Tip: run 'synap use <workspaceId>' to set a default workspace.");
      }
    }
  } catch (e) {
    console.error(chalk.red("Error: " + (e as Error).message));
    process.exit(1);
  }
}

// ─── useWorkspace ─────────────────────────────────────────────────────────────

export async function useWorkspace(
  workspaceId: string,
  opts: BaseOpts
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const userId = await resolveUserId(cfg);
    // Verify the workspace exists and is accessible
    const res = await hubGet("/workspaces", {}, cfg);
    const workspaces = (res as { workspaces?: unknown[] }).workspaces ?? (res as unknown[]);
    const list = Array.isArray(workspaces) ? workspaces as Record<string, unknown>[] : [];
    const match = list.find((w) => w.id === workspaceId || String(w.name).toLowerCase() === workspaceId.toLowerCase());

    if (!match) {
      const names = list.map((w) => `${String(w.name ?? w.id)}`).join(", ");
      console.error(chalk.red(`Workspace '${workspaceId}' not found.`));
      if (names) log.dim(`Available: ${names}`);
      process.exit(1);
    }

    const { setActiveWorkspaceId } = await import("../lib/pod.js");
    setActiveWorkspaceId(String(match.id));

    if (opts.json) {
      console.log(JSON.stringify({ workspaceId: match.id, name: match.name }, null, 2));
      return;
    }
    log.success(`Now in workspace: ${chalk.bold(String(match.name ?? match.id))} ${chalk.dim(String(match.id ?? ""))}`);
    void userId; // consumed by resolveUserId side-effect
  } catch (e) {
    console.error(chalk.red("Error: " + (e as Error).message));
    process.exit(1);
  }
}

// ─── listWorkspaces ───────────────────────────────────────────────────────────

export async function listWorkspaces(opts: BaseOpts): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const res = await hubGet("/workspaces", {}, cfg);
    const workspaces = (res as { workspaces?: unknown[] }).workspaces ?? (res as unknown[]);
    const list = Array.isArray(workspaces) ? workspaces : [];

    if (opts.json) {
      console.log(JSON.stringify({ workspaces: list }, null, 2));
      return;
    }

    if (list.length === 0) {
      log.dim("No workspaces found.");
      return;
    }
    for (const ws of list) {
      const w = ws as Record<string, unknown>;
      log.info(`${String(w.name ?? w.id)}  ${chalk.dim(String(w.id ?? ""))}`);
    }
  } catch (e) {
    console.error(chalk.red("Error: " + (e as Error).message));
    process.exit(1);
  }
}

// ─── listEntities ─────────────────────────────────────────────────────────────

export async function listEntities(
  opts: BaseOpts & { workspace?: string; profile?: string; limit?: string }
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const userId = await resolveUserId(cfg);
    const limit = parseInt(opts.limit ?? "20", 10);
    const res = await hubGet("/entities", {
      userId,
      workspaceId: opts.workspace ?? cfg.workspaceId,
      profileSlug: opts.profile,
      limit,
    }, cfg);
    const entities = (res as { entities?: unknown[] }).entities ?? (res as unknown[]);
    const list = Array.isArray(entities) ? entities : [];

    if (opts.json) {
      console.log(JSON.stringify({ entities: list }, null, 2));
      return;
    }

    if (list.length === 0) {
      log.dim("No entities found.");
      return;
    }
    for (const entity of list) {
      const e = entity as Record<string, unknown>;
      const name = String(e.name ?? e.id ?? "");
      const profile = e.profileSlug ?? e.profile ?? e.type ?? "";
      const id = String(e.id ?? "").slice(0, 8);
      log.info(`${name} ${chalk.dim(`(${profile})`)} — ${chalk.dim(id)}`);
    }
  } catch (e) {
    console.error(chalk.red("Error: " + (e as Error).message));
    process.exit(1);
  }
}

// ─── getEntity ────────────────────────────────────────────────────────────────

export async function getEntity(
  id: string,
  opts: BaseOpts & { workspace?: string }
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const userId = await resolveUserId(cfg);
    const res = await hubGet(`/entities/${id}`, { userId }, cfg);
    const entity = res as Record<string, unknown>;

    if (opts.json) {
      console.log(JSON.stringify(entity, null, 2));
      return;
    }

    log.heading(String(entity.name ?? id));
    log.info(`Profile : ${String(entity.profileSlug ?? entity.profile ?? entity.type ?? "")}`);
    log.info(`ID      : ${String(entity.id ?? id)}`);
    const props = entity.properties as Record<string, unknown> | undefined;
    if (props && Object.keys(props).length > 0) {
      log.blank();
      log.heading("Properties");
      for (const [k, v] of Object.entries(props)) {
        log.info(`${k}: ${String(v)}`);
      }
    }
  } catch (e) {
    console.error(chalk.red("Error: " + (e as Error).message));
    process.exit(1);
  }
}

// ─── searchData ───────────────────────────────────────────────────────────────

export async function searchData(
  query: string,
  opts: BaseOpts & { workspace?: string; type?: string; limit?: string }
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const userId = await resolveUserId(cfg);
    const limit = parseInt(opts.limit ?? "20", 10);

    let collections: string | undefined;
    if (opts.type === "entity") collections = "entities";
    else if (opts.type === "doc") collections = "documents";

    const res = await hubGet("/search", {
      userId,
      query,
      workspaceId: opts.workspace ?? cfg.workspaceId,
      limit,
      collections,
    }, cfg);

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    const data = res as Record<string, unknown>;
    // hits may live at .hits, .results, or top-level array
    const rawHits =
      (data.hits as unknown[]) ??
      (data.results as unknown[]) ??
      (Array.isArray(res) ? (res as unknown[]) : []);

    if (rawHits.length === 0) {
      const workspaceId = opts.workspace ?? cfg.workspaceId;
      log.dim(`No results for "${query}".`);
      if (workspaceId) {
        // Show what IS in the workspace so the user isn't left with a blank wall
        const [profilesRes, entitiesRes] = await Promise.allSettled([
          hubGet("/profiles", { userId, workspaceId }, cfg),
          hubGet("/entities", { userId, workspaceId, limit: 5 }, cfg),
        ]);
        if (profilesRes.status === "fulfilled") {
          const profiles = (profilesRes.value as { profiles?: unknown[] }).profiles ?? (profilesRes.value as unknown[]);
          const pList = Array.isArray(profiles) ? profiles as Record<string, unknown>[] : [];
          if (pList.length > 0) {
            const total = (entitiesRes.status === "fulfilled")
              ? Number((entitiesRes.value as Record<string, unknown>).total ?? 0)
              : 0;
            log.blank();
            log.dim(`This workspace has ${total > 0 ? `${total} entities` : "no entities yet"} across ${pList.length} profile${pList.length !== 1 ? "s" : ""}:`);
            for (const p of pList.slice(0, 6)) {
              log.dim(`  · ${String(p.name ?? p.slug ?? "")} ${chalk.dim(`--profile=${String(p.slug ?? "")}`)}`);
            }
            log.blank();
            log.dim(`Try: synap search <term> --workspace ${workspaceId}`);
            log.dim(`  or synap list --workspace ${workspaceId} --profile <slug>`);
          }
        }
      }
      return;
    }
    for (const hit of rawHits) {
      const h = hit as Record<string, unknown>;
      const name = String(h.name ?? h.title ?? h.id ?? "");
      const type = String(h.profileSlug ?? h.type ?? h.collection ?? "");
      const id = String(h.id ?? "").slice(0, 8);
      log.info(`${name} ${chalk.dim(`[${type}]`)} ${chalk.dim(id)}`);
    }
  } catch (e) {
    console.error(chalk.red("Error: " + (e as Error).message));
    process.exit(1);
  }
}

// ─── rememberData ─────────────────────────────────────────────────────────────

export async function rememberData(
  text: string,
  opts: BaseOpts & { context?: string }
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const userId = await resolveUserId(cfg);
    const res = await hubPost("/memory", {
      userId,
      fact: text,
      sourceEntityId: opts.context,
    }, cfg);

    const data = res as Record<string, unknown>;
    const id = String(data.id ?? "");

    if (opts.json) {
      console.log(JSON.stringify({ id, stored: true }, null, 2));
      return;
    }

    log.success(`Stored: "${text.slice(0, 80)}"`);
  } catch (e) {
    console.error(chalk.red("Error: " + (e as Error).message));
    process.exit(1);
  }
}

// ─── recallData ───────────────────────────────────────────────────────────────

export async function recallData(
  query: string,
  opts: BaseOpts & { limit?: string }
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const userId = await resolveUserId(cfg);
    const limit = parseInt(opts.limit ?? "20", 10);
    const res = await hubGet("/memory", { userId, q: query, limit }, cfg);
    const memories = (res as { memories?: unknown[] }).memories ?? (res as unknown[]);
    const list = Array.isArray(memories) ? memories : [];

    if (opts.json) {
      console.log(JSON.stringify({ memories: list }, null, 2));
      return;
    }

    if (list.length === 0) {
      log.dim("No memories found.");
      return;
    }
    list.forEach((mem, i) => {
      const m = mem as Record<string, unknown>;
      const content = String(m.content ?? m.text ?? "").slice(0, 120);
      log.info(`${i + 1}. ${content}`);
    });
  } catch (e) {
    console.error(chalk.red("Error: " + (e as Error).message));
    process.exit(1);
  }
}

// ─── createEntity ─────────────────────────────────────────────────────────────

export async function createEntity(
  opts: BaseOpts & { profile: string; name: string; workspace?: string; props?: string }
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const userId = await resolveUserId(cfg);
    // parse props as unknown then cast — user-supplied JSON
    const properties = JSON.parse(opts.props ?? "{}") as Record<string, unknown>;
    const res = await hubPost("/entities", {
      userId,
      profileSlug: opts.profile,
      title: opts.name,
      workspaceId: opts.workspace,
      properties,
    }, cfg);

    const entity = res as Record<string, unknown>;

    if (opts.json) {
      console.log(JSON.stringify(entity, null, 2));
      return;
    }

    log.success(`Created: ${String(entity.name ?? opts.name)} (${String(entity.id ?? "")})`);
  } catch (e) {
    console.error(chalk.red("Error: " + (e as Error).message));
    process.exit(1);
  }
}

// ─── listProfiles ─────────────────────────────────────────────────────────────

export async function listProfiles(
  opts: BaseOpts & { workspace?: string; json?: boolean }
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const userId = await resolveUserId(cfg);
    const workspaceId = opts.workspace ?? cfg.workspaceId;
    if (!workspaceId) {
      console.error(chalk.red("No workspace set. Run: synap use <workspace-id>"));
      process.exit(1);
    }
    const res = await hubGet("/profiles", { userId, workspaceId }, cfg);
    const profiles = ((res as Record<string, unknown>).profiles as unknown[] ?? (Array.isArray(res) ? res : [])) as Record<string, unknown>[];

    if (opts.json) {
      console.log(JSON.stringify(profiles, null, 2));
      return;
    }

    if (!profiles.length) {
      log.dim("No profiles found in this workspace.");
      return;
    }

    log.heading(`Profiles in workspace ${workspaceId}`);
    for (const p of profiles) {
      const scope = String(p.entityScope ?? "workspace");
      const desc = p.description ? chalk.dim(` — ${String(p.description).slice(0, 60)}`) : "";
      log.info(`${chalk.bold(String(p.slug ?? ""))}  ${chalk.dim(scope)}${desc}`);
    }
  } catch (e) {
    console.error(chalk.red("Error: " + (e as Error).message));
    process.exit(1);
  }
}

// ─── createRelation ───────────────────────────────────────────────────────────

export async function createRelation(
  opts: BaseOpts & { source: string; target: string; type: string; workspace?: string }
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const userId = await resolveUserId(cfg);
    const res = await hubPost("/relations", {
      userId,
      workspaceId: opts.workspace,
      sourceEntityId: opts.source,
      targetEntityId: opts.target,
      type: opts.type,
    }, cfg);

    const relation = res as Record<string, unknown>;

    if (opts.json) {
      console.log(JSON.stringify(relation, null, 2));
      return;
    }

    log.success(`Created relation: ${opts.type} (${opts.source} → ${opts.target})`);
  } catch (e) {
    console.error(chalk.red("Error: " + (e as Error).message));
    process.exit(1);
  }
}

// ─── updateEntity ─────────────────────────────────────────────────────────────

export async function updateEntity(
  id: string,
  opts: BaseOpts & { props: string }
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    // parse props as unknown then cast — user-supplied JSON
    const properties = JSON.parse(opts.props) as Record<string, unknown>;
    const res = await hubPatch(`/entities/${id}`, {
      userId: cfg.userId,
      properties,
    }, cfg);

    const entity = res as Record<string, unknown>;

    if (opts.json) {
      console.log(JSON.stringify(entity, null, 2));
      return;
    }

    log.success(`Updated: ${id}`);
  } catch (e) {
    console.error(chalk.red("Error: " + (e as Error).message));
    process.exit(1);
  }
}
