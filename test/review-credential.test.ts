/**
 * Review-verb guardrail — `synap proposals approve`.
 *
 * RATIFIED: approve routes to the HUMAN key in the pod profile on disk, behind
 * a TTY + typed-confirmation gate, with the key resolved by a door that never
 * reads the environment.
 *
 * HONEST SCOPE (asserted in the module docblock, restated here so the tests are
 * not read as proving more than they do): this is NOT a security boundary. The
 * agent runs as the same OS user and can read `~/.synap/config.json` itself.
 * These tests pin that the three obstacles exist and fail CLOSED — accident and
 * casual tool-call misuse — not that a deliberate bypass is impossible.
 *
 * The TTY test is the load-bearing one: a guard that degrades to "no TTY, so
 * skip the prompt" is no guard at all, and that degradation is the single most
 * common way this control class is defeated.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  reviewGuard,
  resolveReviewConfig,
  REVIEW_CONFIRM_PHRASE,
  reviewCredentialLabel,
  type GuardIo,
} from "../src/lib/review-credential.js";
import * as podModule from "../src/lib/pod.js";

const ID = "7f3a9c21-1111-4a2b-8c3d-99887766aabb";
const POD = "http://127.0.0.1:1";

/** A terminal that answers `answer`, and records whether it was ever asked. */
function fakeIo(over: Partial<GuardIo> & { answer?: string } = {}): GuardIo & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    isStdinTty: over.isStdinTty ?? true,
    isStdoutTty: over.isStdoutTty ?? true,
    prompt: async (q: string) => {
      asked.push(q);
      return over.answer ?? REVIEW_CONFIRM_PHRASE;
    },
  };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TTY gate fails CLOSED", () => {
  it("refuses when stdin is not a TTY — the agent-subprocess case", async () => {
    const io = fakeIo({ isStdinTty: false });
    const res = await reviewGuard(ID, POD, io);

    expect(res).toEqual({ ok: false, reason: "non-interactive" });
    // Never even asked: a non-interactive caller must not reach the prompt.
    expect(io.asked).toHaveLength(0);
  });

  it("refuses when stdout is not a TTY (piped output)", async () => {
    const io = fakeIo({ isStdoutTty: false });
    expect(await reviewGuard(ID, POD, io)).toEqual({ ok: false, reason: "non-interactive" });
    expect(io.asked).toHaveLength(0);
  });

  it("refuses when NEITHER stream is a TTY", async () => {
    const io = fakeIo({ isStdinTty: false, isStdoutTty: false });
    expect(await reviewGuard(ID, POD, io)).toEqual({ ok: false, reason: "non-interactive" });
  });

  it("points a refused caller at the door that works", async () => {
    const lines: string[] = [];
    (console.log as unknown as ReturnType<typeof vi.fn>).mockImplementation((s?: unknown) =>
      lines.push(String(s))
    );
    await reviewGuard(ID, POD, fakeIo({ isStdinTty: false }));
    const out = lines.join("\n");
    expect(out).toContain(`synap open proposal ${ID}`);
  });
});

describe("typed confirmation", () => {
  it("proceeds only on the exact phrase", async () => {
    const io = fakeIo({ answer: REVIEW_CONFIRM_PHRASE });
    expect(await reviewGuard(ID, POD, io)).toEqual({ ok: true });
    expect(io.asked).toHaveLength(1);
    // A deliberate word, not a keypress — "y" must not be the confirmation.
    expect(REVIEW_CONFIRM_PHRASE.length).toBeGreaterThan(1);
  });

  it("rejects a bare y/yes — the reflex answer must not work", async () => {
    for (const answer of ["y", "yes", "Y", ""]) {
      expect(await reviewGuard(ID, POD, fakeIo({ answer }))).toEqual({
        ok: false,
        reason: "declined",
      });
    }
  });

  it("tolerates surrounding whitespace and casing of the real phrase", async () => {
    expect(await reviewGuard(ID, POD, fakeIo({ answer: `  ${REVIEW_CONFIRM_PHRASE.toUpperCase()} ` }))).toEqual({
      ok: true,
    });
  });

  it("takes no `yes`/auto-confirm parameter at all", () => {
    // Structural, not behavioural: `--yes` cannot bypass the prompt because the
    // guard has nowhere to receive it. (id, podUrl, io) and nothing else.
    expect(reviewGuard.length).toBe(3);
  });
});

describe("credential isolation — env is never consulted", () => {
  const PROFILE = {
    podUrl: "https://pod.example.test",
    workspaceId: "ws-1",
    agentUserId: "human@example.test",
    hubApiKey: "human-key-on-disk",
    savedAt: "2026-01-01",
  };

  it("uses the key from the pod profile on disk", () => {
    vi.spyOn(podModule, "getActivePodConfig").mockReturnValue(PROFILE);
    const cred = resolveReviewConfig();
    expect(cred.kind).toBe("human");
    if (cred.kind !== "human") throw new Error("unreachable");
    expect(cred.config.apiKey).toBe("human-key-on-disk");
  });

  it("IGNORES $SYNAP_HUB_API_KEY — an agent session's ambient key must not review", () => {
    const prev = process.env.SYNAP_HUB_API_KEY;
    process.env.SYNAP_HUB_API_KEY = "agent-key-from-env";
    try {
      vi.spyOn(podModule, "getActivePodConfig").mockReturnValue(PROFILE);
      const cred = resolveReviewConfig();
      if (cred.kind !== "human") throw new Error("unreachable");
      // The whole point: the inherited variable loses to the on-disk profile.
      expect(cred.config.apiKey).toBe("human-key-on-disk");
      expect(cred.config.apiKey).not.toBe("agent-key-from-env");
    } finally {
      if (prev === undefined) delete process.env.SYNAP_HUB_API_KEY;
      else process.env.SYNAP_HUB_API_KEY = prev;
    }
  });

  it("takes no apiKey option — a key cannot be substituted on the command line", () => {
    vi.spyOn(podModule, "getActivePodConfig").mockReturnValue(PROFILE);
    // @ts-expect-error apiKey is deliberately absent from the option type.
    const cred = resolveReviewConfig({ apiKey: "substituted" });
    if (cred.kind !== "human") throw new Error("unreachable");
    expect(cred.config.apiKey).toBe("human-key-on-disk");
  });

  it("honours --pod-url (which pod), never --api-key (who you are)", () => {
    vi.spyOn(podModule, "getActivePodConfig").mockReturnValue(PROFILE);
    const cred = resolveReviewConfig({ podUrl: "https://other.test" });
    if (cred.kind !== "human") throw new Error("unreachable");
    expect(cred.config.podUrl).toBe("https://other.test");
    expect(cred.config.apiKey).toBe("human-key-on-disk");
  });
});

describe("no human key → handoff, not an error", () => {
  it("reports absent when no pod profile is saved", () => {
    vi.spyOn(podModule, "getActivePodConfig").mockReturnValue(null);
    const cred = resolveReviewConfig();
    expect(cred.kind).toBe("absent");
    if (cred.kind !== "absent") throw new Error("unreachable");
    expect(cred.reason).toContain("config.json");
  });

  it("reports absent when the saved profile carries no key", () => {
    vi.spyOn(podModule, "getActivePodConfig").mockReturnValue({
      podUrl: "https://pod.example.test",
      workspaceId: "ws-1",
      agentUserId: "u",
      hubApiKey: "",
      savedAt: "2026-01-01",
    });
    expect(resolveReviewConfig().kind).toBe("absent");
  });
});

describe("credential label is never blank", () => {
  it("falls back to the pod when agentUserId is persisted as an empty string", () => {
    vi.spyOn(podModule, "getActivePodConfig").mockReturnValue({
      podUrl: "https://pod.example.test",
      workspaceId: "ws-1",
      agentUserId: "",
      hubApiKey: "k",
      savedAt: "2026-01-01",
    });
    const cred = resolveReviewConfig();
    if (cred.kind !== "human") throw new Error("unreachable");
    // `??` would have let "" through and rendered "Reviewing as  — human key",
    // which tells the operator less than nothing about which identity acts.
    expect(cred.identity).toBeUndefined();
    expect(reviewCredentialLabel(cred)).toBe("https://pod.example.test");
    expect(reviewCredentialLabel(cred).trim()).not.toBe("");
  });
});
