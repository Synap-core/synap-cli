/**
 * `synap session post <toSessionId> <text>` — an agent's typed message to
 * ANOTHER session (a coordination post): `--intent blocked_on_you | handoff |
 * done | fyi`, the reply's `--cause`, `--ref` pointers to the state behind it.
 *
 * The CLI twin of MCP `synap_post_message` with `toSessionId`. It goes through
 * the Hub door `POST /threads/<target room>/messages` with `intent`, so the
 * pod's ONE codec (`session-post.ts` in synap-backend) decides the sender
 * session (this terminal's bound session, or `--from`), the target and the
 * wake — only blocked_on_you and handoff may wake the other agent, a reply
 * chain wakes at most once, at most 3 wakes per session pair per 10 minutes.
 * The CLI decides none of it and only reports what the pod stamped.
 *
 * `--cause` is how a reply made inside a wake turn names the message that
 * woke it (the feed event id `synap session wait --hook` prints): the pod's
 * hop guard counts on it to stop two agents waking each other forever.
 *
 * A pod that predates coordination posts drops `intent` without a word and
 * stores a plain room post; the reply then carries no `sessionPost`, and this
 * command says so (exit 1) instead of reporting a delivery that did not happen.
 */

import chalk from "chalk";
import { log } from "../utils/logger.js";
import {
  resolveHubConfig,
  resolveUserId,
  hubGet,
  hubPost,
  renderHubError,
} from "../lib/hub-client.js";
import { requireFullId } from "../lib/id.js";
import { type BaseOpts } from "./data.js";

export interface SessionPostOpts extends BaseOpts {
  intent?: string;
  cause?: string;
  from?: string;
  ref?: string[];
}

interface PostResponse {
  success?: boolean;
  messageId?: string;
  sessionPost?: {
    intent: string;
    from: { sessionId: string | null };
    to: { sessionId: string };
    hop: number;
    wake: boolean;
    wakeHeld?: string;
  };
  note?: string;
}

/** `kind:id` or `kind:id:label` → the pod's ref shape. The pod validates kind and id. */
export function parseRef(raw: string): { kind: string; id: string; label?: string } {
  const [kind, id, ...label] = raw.split(":");
  if (!kind || !id) throw new Error(`--ref ${JSON.stringify(raw)}: use kind:id or kind:id:label (e.g. session:<id>).`);
  return label.length > 0 ? { kind, id, label: label.join(":") } : { kind, id };
}

export const SESSION_POST_EXIT = { DELIVERED: 0, NOT_ADDRESSED: 1, FAILURE: 2 } as const;

export async function sessionPostCommand(
  toSessionId: string,
  textParts: string[],
  opts: SessionPostOpts
): Promise<void> {
  requireFullId(toSessionId, "session", chalk, log);
  const text = textParts.join(" ").trim();
  if (!text) {
    console.error(chalk.red("Say something: synap session post <sessionId> \"<text>\""));
    process.exit(SESSION_POST_EXIT.FAILURE);
  }
  let refs: Array<{ kind: string; id: string; label?: string }> | undefined;
  try {
    refs = opts.ref?.length ? opts.ref.map(parseRef) : undefined;
  } catch (e) {
    console.error(chalk.red((e as Error).message));
    process.exit(SESSION_POST_EXIT.FAILURE);
  }

  let res: PostResponse;
  try {
    const cfg = await resolveHubConfig(opts);
    // The target's room: every post to a session lands there.
    const target = (await hubGet(`/focus-sessions/${toSessionId}`, {}, cfg)) as { channelId?: string | null };
    if (!target?.channelId) {
      console.error(chalk.red(`Session ${toSessionId} has no room yet, so it cannot receive a message.`));
      process.exit(SESSION_POST_EXIT.FAILURE);
    }
    const userId = await resolveUserId(cfg);
    res = (await hubPost(`/threads/${target.channelId}/messages`, {
      role: "assistant",
      content: text,
      userId,
      intent: opts.intent ?? "fyi",
      ...(opts.from ? { fromSessionId: opts.from } : {}),
      ...(refs ? { refs } : {}),
      ...(opts.cause ? { cause: opts.cause } : {}),
    }, cfg)) as PostResponse;
  } catch (e) {
    renderHubError(e);
    process.exit(SESSION_POST_EXIT.FAILURE);
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify(res, null, 2));
    process.exit(res.sessionPost ? SESSION_POST_EXIT.DELIVERED : SESSION_POST_EXIT.NOT_ADDRESSED);
  }
  const sp = res.sessionPost;
  if (!sp) {
    log.warn(
      "This pod does not deliver agent messages yet: the text landed in that session's room as a plain post, addressed to no one, waking no one."
    );
    if (res.messageId) log.hint(`Message ${res.messageId}`);
    process.exit(SESSION_POST_EXIT.NOT_ADDRESSED);
  }
  log.success(
    `${sp.intent} sent to session ${sp.to.sessionId.slice(0, 8)}` +
      (sp.wake ? " — it may wake that session's agent." : " — delivered without waking anyone.")
  );
  if (res.note) log.dim(res.note);
  if (!sp.from.sessionId) {
    log.dim("No sender session: this terminal is bound to none, so the other agent cannot reply. Pass --from <your session id>.");
  }
  if (res.messageId) log.dim(`Message ${res.messageId}`);
  process.exit(SESSION_POST_EXIT.DELIVERED);
}
