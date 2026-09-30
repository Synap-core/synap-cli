/**
 * `synap session start` — template auto-match reporting, `--no-template`
 * opt-out, `--criteria <file.json>` forwarding, and "adopted an auto-opened
 * session" — the Lane E surface for the sessions-quality plan's founder
 * decision #1 ("AUTO-apply a matched playbook … AND SAY SO").
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const hubPost = vi.fn(async () => ({ id: "sess-1", goal: "g" }));
const hubGet = vi.fn(async () => ({ id: "user-1" }));

vi.mock("../src/lib/hub-client.js", () => ({
  hubPost,
  hubGet,
  hubPatch: vi.fn(),
  attachActiveSessionId: vi.fn(() => "session-lens"),
  resolveHubConfig: vi.fn(async () => ({
    podUrl: "http://127.0.0.1:1",
    apiKey: "agent-key",
    workspaceId: "ws-config",
  })),
  renderHubError: vi.fn(),
  HubError: class HubError extends Error {},
}));

beforeEach(() => {
  hubPost.mockClear();
  hubGet.mockClear();
});

describe("session start — --no-template opt-out", () => {
  it("sends templateId: null (never omits it, never sends a string)", async () => {
    const { startSession } = await import("../src/commands/sessions.js");
    await startSession({ goal: "g", workspace: "ws-1", template: false, json: true });

    const [, body] = hubPost.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(body.templateId).toBeNull();
  });
});

describe("session start — --criteria file forwarding", () => {
  const file = join(tmpdir(), `synap-cli-criteria-${process.pid}.json`);
  const criteria = [
    { key: "typecheck", statement: "Typecheck passes", check: { kind: "evidence", evidenceKey: "typecheck" } },
  ];

  beforeEach(() => writeFileSync(file, JSON.stringify(criteria)));
  afterEach(() => {
    try {
      unlinkSync(file);
    } catch {
      // already gone
    }
  });

  it("parses the file and forwards the array verbatim", async () => {
    const { startSession } = await import("../src/commands/sessions.js");
    await startSession({ goal: "g", workspace: "ws-1", criteria: file, json: true });

    const [, body] = hubPost.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(body.criteria).toEqual(criteria);
  });

  it("exits with an edge error, not a pod round-trip, for a missing file", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { startSession } = await import("../src/commands/sessions.js");
    await startSession({ goal: "g", workspace: "ws-1", criteria: "/no/such/file.json", json: true });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(hubPost).not.toHaveBeenCalled();

    exitSpy.mockRestore();
    errSpy.mockRestore();
  });
});

describe("session start — human-readable template/adopted reporting", () => {
  it("prints the playbooks that fit, each with the reason and how to bind it", async () => {
    // Auto-apply was retired 2026-09-20: the door OFFERS, it never applies.
    // The reason and the `--template <id>` line are the whole point — a ranked
    // list a reader cannot check, and cannot act on, is a guess with a number.
    hubPost.mockResolvedValueOnce({
      id: "sess-1",
      goal: "g",
      playbooks: {
        candidates: [
          { id: "pb-1", name: "Bug triage", score: 21.5, reason: 'You mentioned "bug"' },
        ],
        optOut: "pass templateId: null",
      },
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const { startSession } = await import("../src/commands/sessions.js");
    await startSession({ goal: "g", workspace: "ws-1" });

    const out = logSpy.mock.calls.flat().join("\n");
    expect(out).toContain("Bug triage");
    expect(out).toContain('You mentioned "bug"');
    expect(out).toContain("--template pb-1");
    // Nothing was applied, and the line must not imply otherwise.
    expect(out).toContain("none applied");

    logSpy.mockRestore();
  });

  it("says nothing about playbooks when the pod offered none", async () => {
    // An ABSENT block (the caller named a template, or an older pod) and an
    // EMPTY candidate list both mean there is nothing to choose from here —
    // the CLI stays quiet rather than printing an empty heading.
    hubPost.mockResolvedValueOnce({
      id: "sess-1",
      goal: "g",
      playbooks: { candidates: [], optOut: "pass templateId: null" },
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const { startSession } = await import("../src/commands/sessions.js");
    await startSession({ goal: "g", workspace: "ws-1" });

    const out = logSpy.mock.calls.flat().join("\n");
    expect(out).not.toContain("Playbooks that fit");

    logSpy.mockRestore();
  });

  it('prints "Continued your auto-opened session" when the response says adopted', async () => {
    hubPost.mockResolvedValueOnce({ id: "sess-1", goal: "g", adopted: true });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const { startSession } = await import("../src/commands/sessions.js");
    await startSession({ goal: "g", workspace: "ws-1" });

    const out = logSpy.mock.calls.flat().join("\n");
    expect(out).toContain("Continued your auto-opened session");

    logSpy.mockRestore();
  });
});
