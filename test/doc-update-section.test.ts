/**
 * `synap doc update --section` reaches the pod's document patch door.
 *
 * Pins the WIRE body: `--section` sends ONE `upsert_section` op to
 * `POST /documents/:id/patch` (never a whole-body PATCH that would rewrite the
 * rest of the document), and `--base-revision` rides along on both forms.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const hubPatch = vi.fn(async () => ({ status: "proposed", proposalId: "p-1" }));
const hubPost = vi.fn(async () => ({ status: "proposed", proposalId: "p-1" }));

vi.mock("../src/lib/hub-client.js", () => ({
  hubPatch,
  hubPost,
  resolveHubConfig: vi.fn(async () => ({ podUrl: "http://127.0.0.1:1", apiKey: "agent-key" })),
  resolveUserId: vi.fn(async () => "user-1"),
}));

beforeEach(() => {
  hubPatch.mockClear();
  hubPost.mockClear();
});

describe("doc update", () => {
  it("--section writes ONE section through the patch door", async () => {
    const { docUpdate } = await import("../src/commands/doc.js");
    await docUpdate("doc-1", {
      section: "risks",
      sectionTitle: "Risks",
      content: "None yet.",
      baseRevision: "7",
      json: true,
    });
    expect(hubPatch).not.toHaveBeenCalled();
    const [path, body] = hubPost.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(path).toBe("/documents/doc-1/patch");
    expect(body).toEqual({
      userId: "user-1",
      ops: [{ op: "upsert_section", id: "risks", title: "Risks", body: "None yet." }],
      baseRevision: 7,
    });
  });

  it("without --section the content replaces the body (PATCH), carrying the base", async () => {
    const { docUpdate } = await import("../src/commands/doc.js");
    await docUpdate("doc-1", { content: "# New", baseRevision: "3", json: true });
    expect(hubPost).not.toHaveBeenCalled();
    const [path, body] = hubPatch.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(path).toBe("/documents/doc-1");
    expect(body).toEqual({ userId: "user-1", content: "# New", baseRevision: 3 });
  });
});
