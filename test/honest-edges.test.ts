/**
 * Six edges where the CLI said less than the truth, or the wrong thing.
 * Each block names the symptom, and each assertion fails with its fix reverted
 * (the negative control is recorded in the PR).
 *
 *   I  `synap worker --agent <unknown>` ran as another agent's key
 *   J  a 429 could park the terminal ~15 min; the pod's body shape was not read
 *   K  `approve` on a page-only proposal printed a raw 409
 *   N  `synap proposals` headed a first page as the whole queue
 *   L  typed capture wrote the retired knowledgeForm "insight"
 *   M  `.cube` (and other plain text) uploaded as octet-stream and got a 415
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { unknownAgentMessage, savedAgentNames } from "../src/lib/agents-config.js";
import { workerCommand } from "../src/commands/worker.js";
import {
  retryAfterMs,
  hubGet,
  HubError,
  HUB_429_MAX_TOTAL_WAIT_MS,
  type HubConfig,
} from "../src/lib/hub-client.js";
import { isReviewOnItsPageRefusal, renderReviewOnItsPage } from "../src/lib/credential-class.js";
import { proposalListHeading } from "../src/commands/data-extra.js";
import { knowledgeFormForType } from "../src/commands/knowledge.js";
import { mimeFor } from "../src/commands/upload.js";

function writeConfig(extra: Record<string, unknown>): void {
  const dir = path.join(os.homedir(), ".synap");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ activePod: "home", ...extra }));
}

beforeEach(() => {
  fs.rmSync(path.join(os.homedir(), ".synap"), { recursive: true, force: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("I: an unknown --agent is refused, with the saved agents listed", () => {
  it("names the saved agents from both stores", () => {
    writeConfig({
      agents: { alpha: { podName: "home", apiKey: "k", createdAt: "" } },
      agentKeys: { "claude-code": { hubApiKey: "k2" } },
    });
    expect(savedAgentNames()).toEqual(["alpha", "claude-code"]);
    expect(unknownAgentMessage("alpha")).toBeNull();
    expect(unknownAgentMessage("claude-code")).toBeNull();
    const msg = unknownAgentMessage("alhpa");
    expect(msg).toContain('"alhpa"');
    expect(msg).toContain("alpha, claude-code");
  });

  it("workerCommand throws before it touches the key ladder", async () => {
    writeConfig({ agents: { alpha: { podName: "home", apiKey: "k", createdAt: "" } } });
    // An ambient key a fall-through would have picked up.
    vi.stubEnv("SYNAP_POD_URL", "https://pod.example.test");
    vi.stubEnv("SYNAP_HUB_API_KEY", "someone-elses-key");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(workerCommand({ agent: "nope" } as never)).rejects.toThrow(/No saved agent named "nope".*alpha/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(process.env.SYNAP_AGENT).not.toBe("nope");
  });
});

describe("J: 429 waits are read from every shape the pod sends, and capped", () => {
  const res = (headers: Record<string, string> = {}) => new Response("", { status: 429, headers });

  it("reads the Retry-After header (seconds)", () => {
    expect(retryAfterMs(res({ "retry-after": "7" }), "")).toBe(7_000);
  });
  it("reads the body's numeric retryAfter (hub commands door)", () => {
    expect(retryAfterMs(res(), JSON.stringify({ error: "Rate limit exceeded", retryAfter: 60 }))).toBe(60_000);
  });
  it("reads cause.retryAfterSec and the 'Retry after 30s.' sentence", () => {
    expect(retryAfterMs(res(), JSON.stringify({ cause: { retryAfterSec: 20 } }))).toBe(20_000);
    expect(retryAfterMs(res(), "Rate limit exceeded. Retry after 30s.")).toBe(30_000);
  });
  it("caps one wait at 75s", () => {
    expect(retryAfterMs(res({ "retry-after": "900" }), "")).toBe(75_000);
  });

  it("gives up once the total wait budget is spent, and says the pod is up", async () => {
    vi.useFakeTimers();
    const cfg = { podUrl: "https://pod.example.test", apiKey: "k", userId: "u" } as HubConfig;
    const fetchSpy = vi.fn(
      async () => new Response("{}", { status: 429, headers: { "retry-after": "60" } })
    );
    vi.stubGlobal("fetch", fetchSpy);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const done = hubGet("/x", {}, cfg).catch((e) => e);
    await vi.advanceTimersByTimeAsync(HUB_429_MAX_TOTAL_WAIT_MS + 60_000);
    const e = await done;
    expect(e).toBeInstanceOf(HubError);
    expect((e as HubError).status).toBe(429);
    expect((e as HubError).message).toContain("the pod is up");
    // 60s waits against a 150s budget: two waits, a third refused. Not 12.
    expect(fetchSpy.mock.calls.length).toBe(3);
    const said = err.mock.calls.map((c) => String(c[0])).join("\n");
    expect(said).toContain("rate-limited; the pod is up; retrying in 60s");
  });
});

describe("K: approve on a page-only proposal prints its page, not a raw 409", () => {
  const cfg = { podUrl: "https://pod.example.test", apiKey: "k", userId: "u" } as HubConfig;
  const id = "0b9f1c52-aaaa-bbbb-cccc-1234567890ab";
  const conflict = new HubError({
    message:
      "Hub POST /proposals/x/approve failed (HTTP 409): Open it to approve: approving this skill turns its code on, and only its page shows the code.",
    status: 409,
    path: "/proposals/x/approve",
    method: "POST",
  } as never);

  it("recognises the 409 and not other failures", () => {
    expect(isReviewOnItsPageRefusal(conflict)).toBe(true);
    expect(isReviewOnItsPageRefusal(new HubError({ message: "m", status: 403, path: "/p", method: "POST" } as never))).toBe(false);
    expect(isReviewOnItsPageRefusal(new Error("409"))).toBe(false);
  });

  it("prints the pod's sentence and the page URL", () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m) => void lines.push(String(m)));
    vi.spyOn(console, "log").mockImplementation((m) => void lines.push(String(m)));
    renderReviewOnItsPage(id, cfg, conflict);
    const out = lines.join("\n");
    expect(out).toContain("approved on its page");
    expect(out).toContain("only its page shows the code");
    expect(out).toContain(id);
    expect(out).toContain("https://pod.example.test");
    expect(out).not.toContain("HTTP 409");
  });
});

describe("N: a first page says it is a page, and how to see more", () => {
  it("a full queue is just the count", () => {
    expect(proposalListHeading(3, "pending proposal", { total: 3, hasMore: false }, 20)).toEqual({
      heading: "3 pending proposals",
    });
  });
  it("hasMore: shows 'N of TOTAL', 'first page' and the --limit door", () => {
    const h = proposalListHeading(20, "pending proposal", { total: 57, hasMore: true }, 20);
    expect(h.heading).toBe("20 of 57 pending proposals (first page)");
    expect(h.more).toContain("synap proposals list --limit 60");
  });
  it("an older pod with no total still flags hasMore", () => {
    const h = proposalListHeading(20, "proposal", { hasMore: true }, 20);
    expect(h.heading).toBe("20 proposals (first page)");
  });
});

describe("L: typed capture writes a knowledgeForm the pod knows", () => {
  it("gotcha is a caution; every other legacy type is a fact, never 'insight'", () => {
    expect(knowledgeFormForType("gotcha")).toBe("caution");
    for (const t of ["lesson", "decision", "reference", undefined]) {
      expect(knowledgeFormForType(t)).toBe("fact");
    }
  });
});

describe("M: plain-text uploads are text/plain, not octet-stream", () => {
  it("maps .cube and its siblings", () => {
    for (const f of ["lut.cube", "a.log", "c.yaml", "c.yml", "c.toml", "c.ini", "c.conf", "t.tsv", "s.srt", "s.vtt"]) {
      expect(mimeFor(f)).toBe("text/plain");
    }
    expect(mimeFor("LUT.CUBE")).toBe("text/plain");
  });
  it("leaves the existing map alone", () => {
    expect(mimeFor("a.pdf")).toBe("application/pdf");
    expect(mimeFor("a.unknownext")).toBe("application/octet-stream");
  });
});
