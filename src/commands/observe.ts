import chalk from "chalk";
import { log } from "../utils/logger.js";
import { resolveHubConfig, hubGet, hubPost, renderHubError } from "../lib/hub-client.js";
import { unwrapList } from "../lib/unwrapList.js";
import { reportWrite } from "../lib/capture-lane.js";
import { type BaseOpts, parseLimit } from "./data.js";

type ObserveCategory = "working_style" | "communication" | "focus" | "technical" | "preference";

const VALID_CATEGORIES: ObserveCategory[] = [
  "working_style",
  "communication",
  "focus",
  "technical",
  "preference",
];

// ─── observeWrite ─────────────────────────────────────────────────────────────

export async function observeWrite(
  text: string,
  opts: BaseOpts & { category?: string; confidence?: string }
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);

    const category = (opts.category ?? "preference") as ObserveCategory;
    if (!VALID_CATEGORIES.includes(category)) {
      console.error(
        chalk.red(
          `Invalid category: ${category}. Must be one of: ${VALID_CATEGORIES.join(" | ")}`
        )
      );
      process.exit(1);
    }

    const confidence = parseFloat(opts.confidence ?? "0.5");
    if (isNaN(confidence) || confidence < 0 || confidence > 1) {
      console.error(chalk.red("Confidence must be a number between 0 and 1"));
      process.exit(1);
    }

    const res = await hubPost(
      "/entities",
      {
        profileSlug: "user_observation",
        title: text.slice(0, 80),
        properties: {
          uo_observation: text,
          uo_category: category,
          uo_confidence: confidence,
          uo_validated: false,
        },
      },
      cfg
    ) as Record<string, unknown>;

    // Honest outcome: an inference (uo_validated:false) is gated → proposed, not
    // silently "recorded". reportWrite reads the response and says which it was.
    await reportWrite(res, {
      label: `Observation: ${text.slice(0, 60)} (${category}, conf ${confidence})`,
      lane: "user",
      cfg,
      json: opts.json,
    });
  } catch (e) {
    renderHubError(e);
    process.exit(1);
  }
}

// ─── observeRecall ────────────────────────────────────────────────────────────

export async function observeRecall(
  query: string,
  opts: BaseOpts & { category?: string; limit?: string }
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const limit = parseLimit(opts.limit, 10);

    const params: Record<string, string | number> = {
      profileSlug: "user_observation",
      q: query,
      limit,
    };

    const res = await hubGet("/entities", params, cfg) as Record<string, unknown>;
    let entities = unwrapList<Record<string, unknown>>(res, ["entities", "items"]);

    if (opts.category) {
      entities = entities.filter((e) => {
        const props = e.properties as Record<string, unknown> | undefined;
        return props?.uo_category === opts.category;
      });
    }

    if (opts.json) {
      console.log(JSON.stringify({ entities }, null, 2));
      return;
    }

    if (entities.length === 0) {
      log.dim("No observations found.");
      return;
    }

    log.heading(`${entities.length} observation${entities.length !== 1 ? "s" : ""}`);
    log.blank();

    for (const e of entities) {
      const props = (e.properties ?? {}) as Record<string, unknown>;
      const category = chalk.cyan(String(props.uo_category ?? "preference"));
      const observation = String(props.uo_observation ?? e.title ?? "");
      const confidence = Number(props.uo_confidence ?? 0.5).toFixed(2);
      log.info(`${category}  ${chalk.dim(`conf:${confidence}`)}  ${observation}`);
    }
  } catch (e) {
    renderHubError(e);
    process.exit(1);
  }
}
