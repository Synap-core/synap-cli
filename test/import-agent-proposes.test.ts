/**
 * `synap import <file.csv> --yes` run by an AGENT ends at the proposal.
 *
 * Observed 2026-10-22 (proposal 0728053b): an agent key ran
 * `synap import Connections.csv --yes`. The pod filed the import proposal,
 * then refused `/import/apply` with HTTP 403 "An agent credential cannot
 * approve proposals" — correct governance, approval is the human step. The CLI
 * printed `failed` and exited 1. It also sent the saved default space
 * ("Brand") as a pin for an import whose every entity is pod-wide.
 *
 * Pinned (driven through `importData`, network mocked):
 *  - an agent (`/users/me` isAgent) never calls `/import/apply`; the outcome is
 *    `proposed` with the review link, exit 0;
 *  - when the pod cannot say (no isAgent), apply runs and the 403 agent
 *    refusal is read as `proposed`, not `failed` (rules out "only the
 *    pre-flight is honest");
 *  - a human key still applies (rules out "never apply");
 *  - the analyze body carries no workspace unless --workspace pins one.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROPOSAL = "0728053b-5fd2-4511-b2e2-d05d0e687f5b";
const DEFAULT_WS = "f001a1a7-56d1-4734-8b9a-cbbe9c28bb01";
const PINNED_WS = "808939d1-86b3-4c52-a153-ae06ece2c54e";

const h = vi.hoisted(() => {
  class HubError extends Error {
    readonly status: number;
    readonly rawBody: string;
    constructor(message: string, status: number, rawBody: string) {
      super(message);
      this.status = status;
      this.rawBody = rawBody;
    }
  }
  return {
    HubError,
    isAgent: undefined as boolean | undefined,
    hubPost: vi.fn(),
    hubGet: vi.fn(),
  };
});

vi.mock("../src/lib/hub-client.js", () => ({
  hubPost: h.hubPost,
  hubGet: h.hubGet,
  resolveHubConfig: vi.fn(async () => ({
    podUrl: "https://pod.example.test",
    apiKey: "test-key",
    userId: "user-1",
    workspaceId: DEFAULT_WS,
  })),
  resolveUserId: vi.fn(async () => "user-1"),
  resolveActiveSessionId: vi.fn(() => undefined),
  renderHubError: vi.fn(),
  HubError: h.HubError,
}));

import { importData } from "../src/commands/import.js";

let dir: string;
let printed: string[];
let exitCodes: number[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "synap-import-agent-"));
  printed = [];
  exitCodes = [];
  h.isAgent = undefined;
  h.hubGet.mockReset().mockImplementation(async (path: string) => {
    if (path === "/users/me") {
      return h.isAgent === undefined ? { id: "user-1" } : { id: "user-1", isAgent: h.isAgent };
    }
    if (path.startsWith("/workspaces")) return { workspaces: [{ id: PINNED_WS, name: "Builder" }] };
    return {};
  });
  h.hubPost.mockReset().mockImplementation(async (path: string) => {
    if (path === "/import/analyze") {
      return {
        proposalId: PROPOSAL,
        workspaceId: null,
        summary: "Import 1 person from Connections.csv",
        operations: [{ op: "create_entity", profileSlug: "person", title: "Ada Quillfeather" }],
      };
    }
    if (path === "/import/apply") {
      if (h.isAgent !== false) {
        throw new h.HubError(
          "Hub POST /import/apply failed (HTTP 403): An agent credential cannot approve proposals",
          403,
          '{"error":"An agent credential cannot approve proposals — approve is human review."}'
        );
      }
      return { created: 1, linked: 0, workspaceId: null };
    }
    return {};
  });
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    printed.push(String(line));
  });
  vi.spyOn(process, "exit").mockImplementation(((code: number) => {
    exitCodes.push(code);
    throw new Error(`exit ${code}`);
  }) as never);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const CSV = [
  "First Name,Last Name,URL,Email Address,Company,Position",
  "Ada,Quillfeather,https://www.linkedin.com/in/ada-q,,Brindlewood Labs,CTO",
].join("\n");

async function run(extra: Record<string, unknown> = {}) {
  const p = join(dir, "Connections.csv");
  writeFileSync(p, CSV, "utf8");
  try {
    await importData([p], { json: true, yes: true, ...extra });
  } catch (e) {
    if (!String(e).includes("exit")) throw e;
  }
  const json = JSON.parse(printed.join("\n")) as {
    imported: Array<{ status: string; reviewUrl?: string; error?: string }>;
  };
  return json.imported[0]!;
}

const posted = (path: string) => h.hubPost.mock.calls.filter((c) => c[0] === path);

describe("an agent's import ends at the proposal, reported as proposed", () => {
  it("an agent never calls apply: proposed, with the review link, exit 0", async () => {
    h.isAgent = true;
    const outcome = await run();
    expect(posted("/import/apply")).toHaveLength(0);
    expect(outcome.status).toBe("proposed");
    expect(outcome.reviewUrl).toContain(PROPOSAL);
    expect(exitCodes.filter((c) => c !== 0)).toEqual([]);
  });

  it("when the pod cannot say, the 403 agent refusal still reads as proposed", async () => {
    h.isAgent = undefined;
    const outcome = await run();
    expect(posted("/import/apply")).toHaveLength(1);
    expect(outcome.status).toBe("proposed");
    expect(outcome.reviewUrl).toContain(PROPOSAL);
    expect(exitCodes.filter((c) => c !== 0)).toEqual([]);
  });

  it("a human key still applies", async () => {
    h.isAgent = false;
    const outcome = await run();
    expect(posted("/import/apply")).toHaveLength(1);
    expect(outcome.status).toBe("stored");
  });
});

describe("the saved default space is not a pin", () => {
  it("analyze carries no workspace without --workspace", async () => {
    h.isAgent = true;
    await run();
    const body = posted("/import/analyze")[0]![1] as Record<string, unknown>;
    expect("workspaceId" in body).toBe(false);
  });

  it("--workspace still pins it", async () => {
    h.isAgent = true;
    await run({ workspace: PINNED_WS });
    const body = posted("/import/analyze")[0]![1] as Record<string, unknown>;
    expect(body.workspaceId).toBe(PINNED_WS);
  });
});
