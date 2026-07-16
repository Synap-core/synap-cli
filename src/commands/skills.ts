import chalk from "chalk";
import { log } from "../utils/logger.js";
import {
  resolveHubConfig,
  hubGet,
  hubPatch,
  hubPost,
} from "../lib/hub-client.js";
import { unwrapList } from "../lib/unwrapList.js";
import { type BaseOpts } from "./data.js";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

export interface SkillOpts extends BaseOpts {
  session?: string;
  workspace?: string;
}

// ─── gatherContext ────────────────────────────────────────────────────────────

/**
 * Gather context for a session:
 * 1. Query /entities/recall from the pod (semantic search in pod KG)
 * 2. Read local CLAUDE.md if it exists
 * 3. Read .claude/kg-verify if it exists
 * Returns a markdown context report and updates the session with it.
 */
export async function gatherContext(opts: SkillOpts & { session: string }): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const sessionId = opts.session;

    if (!sessionId) {
      console.error(chalk.red("Error: --session SESSION_ID is required"));
      process.exit(1);
    }

    const workspaceId = opts.workspace || cfg.workspaceId;
    if (!workspaceId) {
      console.error(chalk.red("Error: --workspace is required or set active workspace with 'synap use'"));
      process.exit(1);
    }

    // Phase 1: Fetch semantic recall from pod
    let contextReport = "# Gathered Context\n\n";
    contextReport += `**Session:** ${sessionId}\n`;
    contextReport += `**Workspace:** ${workspaceId}\n`;
    contextReport += `**Gathered at:** ${new Date().toISOString()}\n\n`;

    contextReport += "## Pod Knowledge Graph\n\n";

    try {
      const recallRes = (await hubPost(
        "/entities/recall",
        { workspaceId, limit: 10 },
        cfg
      )) as {
        entities?: Array<{ id: string; title?: string; profileSlug?: string }>;
      };
      const entities = unwrapList<{ id: string; title?: string; profileSlug?: string }>(recallRes, ["entities"]);

      if (entities.length > 0) {
        contextReport += "### Recent Entities\n\n";
        for (const e of entities) {
          const type = String(e.profileSlug ?? "unknown");
          contextReport += `- **${String(e.title ?? e.id)}** (${type}): ${String(e.id).slice(0, 8)}\n`;
        }
      } else {
        contextReport += "_(No recent entities found in pod)_\n\n";
      }
    } catch (recallErr) {
      contextReport += `_Note: Pod recall failed — ${(recallErr as Error).message}_\n\n`;
    }

    // Phase 2: Read CLAUDE.md if it exists
    contextReport += "## Project Instructions (CLAUDE.md)\n\n";
    const claudeMdPath = resolve(process.cwd(), "CLAUDE.md");
    if (existsSync(claudeMdPath)) {
      try {
        const claudeContent = readFileSync(claudeMdPath, "utf-8");
        const lines = claudeContent.split("\n");
        const truncated = lines.slice(0, 50).join("\n");
        contextReport += "```markdown\n";
        contextReport += truncated;
        if (lines.length > 50) {
          contextReport += `\n... (${lines.length - 50} more lines)\n`;
        }
        contextReport += "```\n\n";
      } catch (fileErr) {
        contextReport += `_Could not read CLAUDE.md — ${(fileErr as Error).message}_\n\n`;
      }
    } else {
      contextReport += "_(CLAUDE.md not found in current directory)_\n\n";
    }

    // Phase 3: Read .claude/kg-verify if it exists
    contextReport += "## KG Verification State (.claude/kg-verify)\n\n";
    const kgVerifyPath = resolve(process.cwd(), ".claude", "kg-verify");
    if (existsSync(kgVerifyPath)) {
      try {
        const kgVerifyContent = readFileSync(kgVerifyPath, "utf-8");
        contextReport += "```\n";
        contextReport += kgVerifyContent;
        contextReport += "```\n\n";
      } catch (fileErr) {
        contextReport += `_Could not read .claude/kg-verify — ${(fileErr as Error).message}_\n\n`;
      }
    } else {
      contextReport += "_(KG verification state not found)_\n\n";
    }

    // Phase 4: Update session with the report
    try {
      await hubPatch(
        `/focus-sessions/${sessionId}`,
        {
          workspaceId,
          contextReport,
        },
        cfg
      );
    } catch (patchErr) {
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              success: false,
              error: "Failed to update session with context report",
              details: (patchErr as Error).message,
            },
            null,
            2
          )
        );
      } else {
        console.error(
          chalk.yellow("⚠ Context gathered but failed to update session: " + (patchErr as Error).message)
        );
      }
    }

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            success: true,
            sessionId,
            workspaceId,
            reportLength: contextReport.length,
          },
          null,
          2
        )
      );
      return;
    }

    log.success(`Context gathered and session updated`);
    log.dim(`Session: ${sessionId.slice(0, 8)}`);
    log.dim(`Report: ${contextReport.length} bytes`);
  } catch (e) {
    console.error(chalk.red("Error: " + (e as Error).message));
    process.exit(1);
  }
}

// ─── verifyCode ───────────────────────────────────────────────────────────────

/**
 * Run the project's type-check + test gate and store the result on the session.
 * The AI reads CLAUDE.md to find the right commands; this function accepts them
 * explicitly so the AI can pass exactly what to run.
 *
 * Usage: synap skill verify-code --session <id> --workspace <id> --cmd "pnpm type-check"
 */
export async function verifyCode(
  opts: SkillOpts & { session: string; cmd?: string }
): Promise<void> {
  const { execSync } = await import("child_process");
  const cfg = await resolveHubConfig(opts);
  const sessionId = opts.session;

  if (!sessionId) {
    console.error(chalk.red("Error: --session SESSION_ID is required"));
    process.exit(1);
  }

  const workspaceId = opts.workspace || cfg.workspaceId;
  if (!workspaceId) {
    console.error(chalk.red("Error: --workspace is required"));
    process.exit(1);
  }

  const cmd = opts.cmd;
  if (!cmd) {
    console.error(chalk.red("Error: --cmd <command> is required (e.g. --cmd 'pnpm type-check')"));
    process.exit(1);
  }

  const startedAt = Date.now();
  let passed = false;
  let output = "";

  try {
    output = execSync(cmd, { encoding: "utf-8", stdio: "pipe" });
    passed = true;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    output = [err.stdout, err.stderr, err.message].filter(Boolean).join("\n");
    passed = false;
  }

  const elapsedMs = Date.now() - startedAt;
  const verificationReport = {
    codeQuality: {
      cmd,
      passed,
      elapsedMs,
      output: output.slice(0, 4000),
      ranAt: new Date().toISOString(),
    },
  };

  try {
    await hubPatch(
      `/focus-sessions/${sessionId}`,
      { workspaceId, verificationReport },
      cfg
    );
  } catch {
    // non-fatal — still print the result
  }

  if (opts.json) {
    console.log(JSON.stringify({ passed, cmd, elapsedMs, output }, null, 2));
    return;
  }

  if (passed) {
    log.success(`Verification passed  (${elapsedMs}ms)`);
    log.dim(`  cmd: ${cmd}`);
  } else {
    log.warn(`Verification FAILED  (${elapsedMs}ms)`);
    log.dim(`  cmd: ${cmd}`);
    console.log(chalk.red(output.slice(0, 2000)));
    process.exit(1);
  }
}
