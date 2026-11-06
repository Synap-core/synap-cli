/**
 * `synap doc create` makes an html PAGE through the pod's create door.
 *
 * Pod admin runs a stored `documents.type = "html"` at /open/<id>, and
 * `POST /api/hub/documents` accepts `type`, but `doc create` always sent
 * `type: "markdown"`: a page could only reach the pod as an uploaded file.
 *
 * Pins the WIRE body (`type` on POST /documents) for --type and for a
 * `.html` --file, and that the receipt's `warnings` (what will not run in
 * the page's frame) are shown, not swallowed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const hubPost = vi.fn(
  async (): Promise<Record<string, unknown>> => ({ status: "created", id: "doc-1" })
);

vi.mock("../src/lib/hub-client.js", () => ({
  hubPost,
  hubPatch: vi.fn(),
  resolveHubConfig: vi.fn(async () => ({
    podUrl: "http://127.0.0.1:1",
    apiKey: "agent-key",
    workspaceId: "ws-1",
  })),
  resolveUserId: vi.fn(async () => "user-1"),
}));

let dir: string;
beforeEach(() => {
  hubPost.mockClear();
  dir = mkdtempSync(join(tmpdir(), "doc-create-html-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const sentBody = () =>
  (hubPost.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];

describe("doc create --type html", () => {
  it("--type html sends type html to POST /documents", async () => {
    const { docCreate } = await import("../src/commands/doc.js");
    await docCreate({ title: "Report", content: "<p>hi</p>", type: "html", json: true });
    const [path] = hubPost.mock.calls[0] as unknown as [string];
    expect(path).toBe("/documents");
    expect(sentBody()).toMatchObject({ type: "html", content: "<p>hi</p>", title: "Report" });
  });

  it("a .html --file is a page without --type", async () => {
    const file = join(dir, "report.html");
    writeFileSync(file, "<!doctype html><p>hi</p>");
    const { docCreate } = await import("../src/commands/doc.js");
    await docCreate({ title: "Report", file, json: true });
    expect(sentBody()).toMatchObject({ type: "html", content: "<!doctype html><p>hi</p>" });
  });

  it("a .md --file and no --type stay markdown", async () => {
    const file = join(dir, "notes.md");
    writeFileSync(file, "# Notes");
    const { docCreate } = await import("../src/commands/doc.js");
    await docCreate({ title: "Notes", file, json: true });
    expect(sentBody()).toMatchObject({ type: "markdown" });
  });

  it("--type markdown wins over a .html file name", async () => {
    const file = join(dir, "page.html");
    writeFileSync(file, "<p>source to read</p>");
    const { docCreate } = await import("../src/commands/doc.js");
    await docCreate({ title: "Source", file, type: "markdown", json: true });
    expect(sentBody()).toMatchObject({ type: "markdown" });
  });

  it("the receipt's warnings are shown", async () => {
    hubPost.mockResolvedValueOnce({
      status: "created",
      id: "doc-2",
      warnings: ["This page loads code from cdn.example.com. Pages run with no network, so that code never loads and the page does not run."],
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { docCreate } = await import("../src/commands/doc.js");
    await docCreate({ title: "Report", content: "<script src=https://cdn.example.com/x.js></script>", type: "html" });
    expect(err.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "This page loads code from cdn.example.com"
    );
  });

  it("an unknown --type is refused before anything is sent", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { docCreate } = await import("../src/commands/doc.js");
    await expect(
      docCreate({ title: "X", content: "x", type: "pdf" })
    ).rejects.toThrow();
    expect(exit).toHaveBeenCalledWith(1);
    expect(hubPost).not.toHaveBeenCalled();
  });
});
