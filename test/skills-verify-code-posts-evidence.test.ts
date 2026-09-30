/**
 * `synap skill verify-code` must keep writing `verificationReport` via PATCH
 * (the browser's VerificationBadge reads it) AND ALSO post the same result as
 * evidence under key "codeQuality", so a `codeQuality` acceptance criterion
 * (check.kind: "evidence", evidenceKey: "codeQuality") is graded by the same
 * run — Lane E task 3 of the sessions-quality plan.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const hubPatch = vi.fn(async () => ({}));
const hubPost = vi.fn(async () => ({ status: "evaluated", results: [] }));

vi.mock("../src/lib/hub-client.js", () => ({
  hubPatch,
  hubPost,
  hubGet: vi.fn(),
  resolveHubConfig: vi.fn(async () => ({
    podUrl: "http://127.0.0.1:1",
    apiKey: "agent-key",
    workspaceId: "ws-config",
  })),
  renderHubError: vi.fn(),
}));

beforeEach(() => {
  hubPatch.mockClear();
  hubPost.mockClear();
});

describe("skill verify-code — evidence + PATCH", () => {
  it("keeps the verificationReport PATCH and ALSO posts codeQuality evidence, on success", async () => {
    const { verifyCode } = await import("../src/commands/skills.js");
    await verifyCode({ session: "sess-1", workspace: "ws-1", cmd: "node -e \"process.exit(0)\"", json: true });

    expect(hubPatch).toHaveBeenCalledTimes(1);
    const [patchPath, patchBody] = hubPatch.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(patchPath).toBe("/focus-sessions/sess-1");
    expect((patchBody.verificationReport as Record<string, unknown>).codeQuality).toBeTruthy();

    expect(hubPost).toHaveBeenCalledTimes(1);
    const [postPath, postBody] = hubPost.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(postPath).toBe("/focus-sessions/sess-1/evidence");
    const evidence = (postBody.evidence as Record<string, { passed: boolean }>).codeQuality;
    expect(evidence.passed).toBe(true);
  });

  it("posts passed: false when the command fails, and still exits 1", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // Not --json: exercises the non-json branch, which is the one that
    // calls process.exit(1) on a failed gate.
    const { verifyCode } = await import("../src/commands/skills.js");
    await verifyCode({ session: "sess-1", workspace: "ws-1", cmd: "node -e \"process.exit(1)\"" });

    const [, postBody] = hubPost.mock.calls[0] as unknown as [string, Record<string, unknown>];
    const evidence = (postBody.evidence as Record<string, { passed: boolean }>).codeQuality;
    expect(evidence.passed).toBe(false);
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    logSpy.mockRestore();
  });
});
