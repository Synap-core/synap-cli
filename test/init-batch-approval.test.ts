/**
 * One-click approval for `synap init` (V1 D5): every approval-gated key is
 * minted first, ONE page is opened for all of them, and the installers then
 * receive the approved keys instead of minting (and asking) again.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import {
  TARGET_KEY_MINT,
  approveAgentKeysAtOnce,
  batchReviewUrl,
  takePreApprovedKey,
} from "../src/lib/batch-approval.js";

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
      .mockRejectedValueOnce(new Error("codex was not approved."))
      .mockResolvedValueOnce(undefined);
    const r = await approveAgentKeysAtOnce(POD, "human-key", ["codex", "cursor"], {
      provision: provisionReturning({ codex: { pending: true }, cursor: { pending: true } }),
      poll,
      openUrl: vi.fn(),
    });
    expect(r.notApproved).toEqual(["codex"]);
    expect(takePreApprovedKey("codex")).toBeUndefined();
    expect(takePreApprovedKey("cursor")).toBeDefined();

    const failed = await approveAgentKeysAtOnce(POD, "human-key", ["codex"], {
      provision: provisionReturning({ codex: { fail: true } }),
      poll: vi.fn(),
      openUrl: vi.fn(),
    });
    expect(failed.notApproved).toEqual(["codex"]);
  });

  it("a single pending key opens its own review page", async () => {
    const openUrl = vi.fn();
    await approveAgentKeysAtOnce(POD, "human-key", ["codex"], {
      provision: provisionReturning({ codex: { pending: true } }),
      poll: vi.fn().mockResolvedValue(undefined),
      openUrl,
    });
    expect(openUrl).toHaveBeenCalledWith(REVIEW("tok-codex"));
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

  it("provisionAgentKey consumes a pre-approved key before minting", () => {
    const body = src.slice(src.indexOf("export async function provisionAgentKey("));
    const take = body.indexOf("takePreApprovedKey(agentType)");
    const fetchAt = body.indexOf("/api/hub/setup/agent`");
    expect(take).toBeGreaterThan(0);
    expect(take).toBeLessThan(fetchAt);
  });

  it("init runs the one-click step before installing", () => {
    const init = fs.readFileSync(path.join(__dirname, "../src/commands/init.ts"), "utf8");
    const step = init.indexOf("await approveAgentKeysAtOnce(");
    expect(step).toBeGreaterThan(0);
    expect(step).toBeLessThan(init.indexOf("await installForTarget(target"));
  });
});
