/**
 * One-click approval for `synap init` (V1 D5): every approval-gated key is
 * minted first, ONE page is opened for all of them, and the installers then
 * receive the approved keys instead of minting (and asking) again.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import {
  TARGET_KEY_MINT,
  approveAgentKeysAtOnce,
  batchReviewUrl,
  podSupportsBatchApproval,
  takePreApprovedKey,
} from "../src/lib/batch-approval.js";
import { connectAgents } from "../src/lib/init-connect.js";
import { AgentKeyMintError, provisionAgentKey } from "../src/lib/targets.js";

const POD = "https://pod.example.synap.live";
const REVIEW = (id: string) =>
  `https://pod-admin.example.synap.live/approve-agent/${id}?agentType=codex`;

type Provision = NonNullable<Parameters<typeof approveAgentKeysAtOnce>[3]>["provision"];

function provisionReturning(
  byType: Record<string, { pending?: boolean; fail?: boolean }>
): Provision {
  return vi.fn(async (_pod: string, _key: string, agentType: string, opts?: { deferApproval?: boolean }) => {
    expect(opts?.deferApproval).toBe(true);
    const b = byType[agentType] ?? {};
    if (b.fail) throw new Error(`${agentType} mint failed`);
    return {
      hubApiKey: `key-${agentType}`,
      agentUserId: `agent-${agentType}`,
      reused: false,
      ...(b.pending
        ? { pending: { pendingToken: `tok-${agentType}`, reviewUrl: REVIEW(`tok-${agentType}`) } }
        : {}),
    };
  }) as unknown as Provision;
}

beforeEach(() => {
  // Drain anything a previous test left ready.
  for (const t of ["codex", "cursor"]) takePreApprovedKey(t);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const batchPod = async () => true;

describe("batchReviewUrl", () => {
  it("is the pod admin's /approve-agents page, on the single review URL's origin, naming every key", () => {
    expect(batchReviewUrl(REVIEW("a"), ["a", "b"])).toBe(
      "https://pod-admin.example.synap.live/approve-agents?keys=a,b"
    );
  });
});

describe("approveAgentKeysAtOnce", () => {
  it("mints Codex + Cursor, opens ONE page for both, and hands the approved keys to the installers", async () => {
    const openUrl = vi.fn();
    const poll = vi.fn().mockResolvedValue(undefined);
    const provision = provisionReturning({ codex: { pending: true }, cursor: { pending: true } });

    const r = await approveAgentKeysAtOnce(POD, "human-key", ["claude-code", "codex", "cursor"], {
      provision,
      poll,
      openUrl,
      supportsBatch: batchPod,
    });

    expect(r.notApproved).toEqual([]);
    // Claude Code mints without approval — not pre-minted.
    expect(provision).toHaveBeenCalledTimes(2);
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith(
      "https://pod-admin.example.synap.live/approve-agents?keys=tok-codex,tok-cursor"
    );
    // Each key is polled on the existing per-key status door.
    expect(poll.mock.calls.map((c) => c[0].url)).toEqual([
      `${POD}/api/hub/setup/agent/pending/tok-codex`,
      `${POD}/api/hub/setup/agent/pending/tok-cursor`,
    ]);
    // Installers get the approved keys, once.
    expect(takePreApprovedKey("codex")).toEqual({ hubApiKey: "key-codex", agentUserId: "agent-codex" });
    expect(takePreApprovedKey("codex")).toBeUndefined();
    expect(takePreApprovedKey("cursor")).toMatchObject({ hubApiKey: "key-cursor" });
  });

  it("a rejected or failed key is reported, never handed to an installer; the approved one still is", async () => {
    const poll = vi
      .fn()
      .mockRejectedValueOnce(new Error("It was declined on the pod."))
      .mockResolvedValueOnce(undefined);
    const r = await approveAgentKeysAtOnce(POD, "human-key", ["codex", "cursor"], {
      provision: provisionReturning({ codex: { pending: true }, cursor: { pending: true } }),
      poll,
      openUrl: vi.fn(),
      supportsBatch: batchPod,
    });
    expect(r.notApproved).toEqual(["codex"]);
    expect(r.reasons).toEqual({ codex: "It was declined on the pod." });
    expect(takePreApprovedKey("codex")).toBeUndefined();
    expect(takePreApprovedKey("cursor")).toBeDefined();

    const failed = await approveAgentKeysAtOnce(POD, "human-key", ["codex"], {
      provision: provisionReturning({ codex: { fail: true } }),
      poll: vi.fn(),
      openUrl: vi.fn(),
    });
    expect(failed.notApproved).toEqual(["codex"]);
    expect(failed.reasons.codex).toBe("codex mint failed");
  });

  it("an old pod without the batch page gets each key's own review page", async () => {
    const openUrl = vi.fn();
    const supportsBatch = vi.fn().mockResolvedValue(false);
    const r = await approveAgentKeysAtOnce(POD, "human-key", ["codex", "cursor"], {
      provision: provisionReturning({ codex: { pending: true }, cursor: { pending: true } }),
      poll: vi.fn().mockResolvedValue(undefined),
      openUrl,
      supportsBatch,
    });
    expect(supportsBatch).toHaveBeenCalledWith(POD);
    expect(openUrl.mock.calls.map((c) => c[0])).toEqual([REVIEW("tok-codex"), REVIEW("tok-cursor")]);
    expect(r.notApproved).toEqual([]);
  });

  it("a single pending key opens its own review page, without probing the pod", async () => {
    const openUrl = vi.fn();
    const supportsBatch = vi.fn().mockResolvedValue(true);
    await approveAgentKeysAtOnce(POD, "human-key", ["codex"], {
      provision: provisionReturning({ codex: { pending: true } }),
      poll: vi.fn().mockResolvedValue(undefined),
      openUrl,
      supportsBatch,
    });
    expect(openUrl).toHaveBeenCalledWith(REVIEW("tok-codex"));
    expect(supportsBatch).not.toHaveBeenCalled();
  });

  it("nothing pending (a reused, already-valid key) opens no page", async () => {
    const openUrl = vi.fn();
    await approveAgentKeysAtOnce(POD, "human-key", ["cursor"], {
      provision: provisionReturning({ cursor: {} }),
      poll: vi.fn(),
      openUrl,
    });
    expect(openUrl).not.toHaveBeenCalled();
    expect(takePreApprovedKey("cursor")).toMatchObject({ hubApiKey: "key-cursor" });
  });
});

describe("the installers mint what the pre-mint minted", () => {
  // Source scan: `installCodex` / `installCursor` must read their mint spec
  // from TARGET_KEY_MINT — a literal "codex" there could drift from the table
  // and the pre-approved key would never be picked up.
  const src = fs.readFileSync(path.join(__dirname, "../src/lib/targets.ts"), "utf8");

  it.each(Object.keys(TARGET_KEY_MINT))("%s reads TARGET_KEY_MINT", (target) => {
    expect(src).toContain(`TARGET_KEY_MINT.${target}!`);
  });

});

describe("podSupportsBatchApproval (old pods)", () => {
  const answering = (status: number) => vi.fn().mockResolvedValue(new Response("{}", { status }));

  it("reads the batch lookup door: 401/400 = served, 404 = an older pod", async () => {
    const f = answering(401);
    vi.stubGlobal("fetch", f);
    expect(await podSupportsBatchApproval(`${POD}/`)).toBe(true);
    expect(f.mock.calls[0]![0]).toBe(`${POD}/api/hub/setup/agent/pending/lookup`);
    vi.stubGlobal("fetch", answering(400));
    expect(await podSupportsBatchApproval(POD)).toBe(true);
    vi.stubGlobal("fetch", answering(404));
    expect(await podSupportsBatchApproval(POD)).toBe(false);
  });

  it("an unreachable pod reads as 'no batch page' (the per-key pages work everywhere)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    expect(await podSupportsBatchApproval(POD)).toBe(false);
  });
});

describe("provisionAgentKey and the pre-approved key", () => {
  it("hands the approved key to the installer without minting, exactly once", async () => {
    await approveAgentKeysAtOnce(POD, "human-key", ["codex"], {
      provision: provisionReturning({ codex: {} }),
      poll: vi.fn(),
      openUrl: vi.fn(),
    });
    const f = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ hubApiKey: "fresh", agentUserId: "agent-fresh" }), { status: 200 })
    );
    vi.stubGlobal("fetch", f);

    const first = await provisionAgentKey(POD, "human-key", "codex", { idempotent: true });
    expect(first).toEqual({ hubApiKey: "key-codex", agentUserId: "agent-codex", reused: false });
    expect(f).not.toHaveBeenCalled();

    const second = await provisionAgentKey(POD, "human-key", "codex");
    expect(second.hubApiKey).toBe("fresh");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("a deferred mint that names no agent fails loudly instead of handing out an empty id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ hubApiKey: "k", requiresApproval: true, pendingToken: "t", reviewUrl: REVIEW("t") }),
          { status: 200 }
        )
      )
    );
    await expect(
      provisionAgentKey(POD, "human-key", "codex", { deferApproval: true })
    ).rejects.toBeInstanceOf(AgentKeyMintError);
  });
});

describe("connectAgents (the agents step of init)", () => {
  function run(opts: { notApproved?: string[]; failing?: Record<string, { output: string; error?: string }> } = {}) {
    const order: string[] = [];
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m: string) => void lines.push(String(m)));
    vi.spyOn(console, "error").mockImplementation((m: string) => void lines.push(String(m)));
    vi.spyOn(process.stdout, "write").mockImplementation((m: string | Uint8Array) => {
      lines.push(String(m));
      return true;
    });
    const labels: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor" };
    const deps = {
      approve: vi.fn(async (targets: readonly string[]) => {
        order.push(`approve:${targets.join(",")}`);
        const notApproved = (opts.notApproved ?? []) as never[];
        return { notApproved, reasons: Object.fromEntries(notApproved.map((t) => [t, "It was declined on the pod."])) };
      }),
      install: vi.fn(async (target: string) => {
        order.push(`install:${target}`);
        const f = opts.failing?.[target];
        return f ? { ok: false, ...f } : { ok: true, output: "installer chatter" };
      }),
      labelOf: (t: string) => labels[t] ?? t,
    };
    return { order, lines, deps };
  }

  it("approves every key in ONE step before any install, and never installs an unapproved agent", async () => {
    const { order, lines, deps } = run({ notApproved: ["codex"] });
    const r = await connectAgents(["claude-code", "codex", "cursor"] as never[], deps as never);
    expect(order).toEqual(["approve:claude-code,codex,cursor", "install:claude-code", "install:cursor"]);
    expect(r).toEqual({ connected: ["claude-code", "cursor"], notApproved: ["codex"], failed: [] });
    const text = lines.join("\n");
    expect(text).toContain("Codex wasn't approved. Retry:");
    expect(text).toContain("synap connect --target=codex");
    expect(text).toContain("✓ Cursor connected");
  });

  it("a successful install is one line; a failed one replays what the installer printed", async () => {
    const { lines, deps } = run({ failing: { cursor: { output: "HTTP 500 from pod\n", error: "boom." } } });
    const r = await connectAgents(["codex", "cursor"] as never[], deps as never);
    expect(r.failed).toEqual(["cursor"]);
    const text = lines.join("\n");
    expect(text).not.toContain("installer chatter");
    expect(text).toContain("HTTP 500 from pod");
    expect(text).toContain("Cursor wasn't connected: boom. Retry:");
  });

  it("nothing picked: nothing approved, nothing installed", async () => {
    const { order, deps } = run();
    expect(await connectAgents([], deps as never)).toEqual({ connected: [], notApproved: [], failed: [] });
    expect(order).toEqual([]);
  });
});
