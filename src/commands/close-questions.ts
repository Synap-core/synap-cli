/**
 * `synap session close` and the agent's open questions. The pod refuses an
 * agent's close while a question it asked in the session's room is still open
 * (409, `reasonCode: "OPEN_QUESTIONS"`), unless the close carries the agent's
 * word on each one (`questionDispositions`, POST /focus-sessions/:id/complete):
 *   --withdraw <messageId>=<note>   the work overtook it
 *   --keep-owed <messageId>         the person still owes the answer after this session
 * An answer the person gave in chat is relayed first (relay_answer), not here.
 */
import { HubError } from "../lib/hub-client.js";

export interface CloseQuestionDisposition {
  messageId: string;
  disposition: "withdrawn" | "keep_as_owed";
  note?: string;
}

export interface OpenQuestionAtClose {
  messageId: string;
  shortId?: string;
  text: string;
  slotLabel?: string | null;
}

/** The flags as the pod's `questionDispositions`, or the first malformed flag. Pure. */
export function closeQuestionDispositions(flags: {
  withdraw?: readonly string[];
  keepOwed?: readonly string[];
}):
  | { ok: true; dispositions: CloseQuestionDisposition[] }
  | { ok: false; error: string } {
  const dispositions: CloseQuestionDisposition[] = [];
  for (const raw of flags.withdraw ?? []) {
    const at = raw.indexOf("=");
    const messageId = (at === -1 ? raw : raw.slice(0, at)).trim();
    const note = at === -1 ? "" : raw.slice(at + 1).trim();
    if (!messageId || !note) {
      return {
        ok: false,
        error: `--withdraw takes <messageId>=<why it is no longer needed> (got "${raw}")`,
      };
    }
    dispositions.push({ messageId, disposition: "withdrawn", note });
  }
  for (const raw of flags.keepOwed ?? []) {
    const messageId = raw.trim();
    if (!messageId) return { ok: false, error: "--keep-owed takes a messageId" };
    dispositions.push({ messageId, disposition: "keep_as_owed" });
  }
  return { ok: true, dispositions };
}

/** The pod's open-questions refusal of a close, or null for any other error. Pure. */
export function openQuestionsRefusal(
  err: unknown
): { error: string; openQuestions: OpenQuestionAtClose[] } | null {
  if (!(err instanceof HubError) || err.status !== 409) return null;
  const body = err.body as {
    status?: unknown;
    reasonCode?: unknown;
    error?: unknown;
    openQuestions?: unknown;
  } | null;
  if (body?.status !== "refused" || body.reasonCode !== "OPEN_QUESTIONS") {
    return null;
  }
  return {
    error: typeof body.error === "string" ? body.error : err.message,
    openQuestions: Array.isArray(body.openQuestions)
      ? (body.openQuestions as OpenQuestionAtClose[])
      : [],
  };
}
