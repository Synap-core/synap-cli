import { describe, expect, it } from "vitest";
import { HubError } from "../lib/hub-client.js";
import {
  closeQuestionDispositions,
  openQuestionsRefusal,
} from "./close-questions.js";

const Q = "5f3a1c88-1111-4bbb-8ccc-444444444444";
const Q2 = "5f3a1c88-1111-4bbb-8ccc-555555555555";

const hubError = (status: number, body: unknown) =>
  new HubError({
    message: `HTTP ${status}`,
    status,
    body,
    rawBody: JSON.stringify(body),
    path: `/focus-sessions/x/complete`,
    method: "POST",
  });

describe("closeQuestionDispositions", () => {
  it("turns the flags into the pod's dispositions, the note after the first =", () => {
    expect(
      closeQuestionDispositions({
        withdraw: [`${Q}=plan changed = no deploy`],
        keepOwed: [Q2],
      })
    ).toEqual({
      ok: true,
      dispositions: [
        { messageId: Q, disposition: "withdrawn", note: "plan changed = no deploy" },
        { messageId: Q2, disposition: "keep_as_owed" },
      ],
    });
  });

  it("refuses a withdraw with no note, never sends it as keep-owed", () => {
    const r = closeQuestionDispositions({ withdraw: [Q] });
    expect(r.ok).toBe(false);
    expect(closeQuestionDispositions({ withdraw: [`${Q}=  `] }).ok).toBe(false);
  });

  it("no flags: no dispositions", () => {
    expect(closeQuestionDispositions({})).toEqual({ ok: true, dispositions: [] });
  });
});

describe("openQuestionsRefusal", () => {
  const open = [{ messageId: Q, shortId: "Q-5f3a1c88", text: "Deploy?", slotLabel: null }];

  it("reads the pod's open-questions refusal with its list", () => {
    expect(
      openQuestionsRefusal(
        hubError(409, {
          status: "refused",
          reasonCode: "OPEN_QUESTIONS",
          error: "Not closed: 1 question(s) …",
          openQuestions: open,
        })
      )
    ).toEqual({ error: "Not closed: 1 question(s) …", openQuestions: open });
  });

  it("any other error is not this refusal", () => {
    expect(openQuestionsRefusal(hubError(409, { error: "already closed" }))).toBeNull();
    expect(
      openQuestionsRefusal(hubError(403, { status: "refused", reasonCode: "OPEN_QUESTIONS" }))
    ).toBeNull();
    expect(openQuestionsRefusal(new Error("boom"))).toBeNull();
  });
});
