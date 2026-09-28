/**
 * `synap orient` prints each space's PURPOSE — in light mode too, not only
 * the onboarding goal of an empty space under --details — and the pinned
 * space's brief when the pod sends one.
 *
 * Driven through the REAL `orient` command with only the hub read stubbed:
 * the payloads below are `GET /orient` wire shapes (light and full), so the
 * assertions read what a user actually sees on stdout.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({ payload: {} as Record<string, unknown>, calls: [] as unknown[] }));

vi.mock("../src/lib/hub-client.js", () => ({
  hubGet: vi.fn(async (path: string, query: unknown) => {
    h.calls.push([path, query]);
    return h.payload;
  }),
  hubPost: vi.fn(),
  hubPatch: vi.fn(),
  resolveHubConfig: vi.fn(async () => ({ podUrl: "http://pod.test", apiKey: "k", userId: "u1" })),
  resolveUserId: vi.fn(async () => "u1"),
  resolveActiveSessionId: vi.fn(),
  renderHubError: vi.fn((e: unknown) => {
    throw e;
  }),
}));

const BRAND = "f001a1a7-56d1-4734-8b9a-cbbe9c28bb01";
const FOUNDATION = "0000aaaa-0000-4000-8000-000000000003";

let lines: string[] = [];
beforeEach(() => {
  lines = [];
  h.calls = [];
  delete process.env.SYNAP_LENS_SESSION;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  });
});
afterEach(() => vi.restoreAllMocks());

// eslint-disable-next-line no-control-regex
const plain = () => lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));

const lightPayload = {
  detail: "light",
  me: { userId: "u1", scopes: [] },
  projects: [],
  profiles: [],
  note: "",
  workspaces: [
    {
      id: BRAND,
      name: "Brand Library",
      domain: "brand",
      entityCount: 39,
      description: "Reusable source of truth for brand identity, colors, typography, assets…",
    },
    {
      id: FOUNDATION,
      name: "Foundation",
      domain: "foundation",
      entityCount: 0,
      description: "Capture mission, audience and positioning.",
      onboarding: { goal: "Capture mission, audience and positioning." },
    },
  ],
};

describe("synap orient — each space's purpose", () => {
  it("light: every listed space prints its purpose under its name", async () => {
    h.payload = lightPayload;
    const { orient } = await import("../src/commands/data.js");
    await orient({});
    const out = plain();
    const brandAt = out.findIndex((l) => l.includes("Brand Library") && l.includes(BRAND));
    expect(brandAt).toBeGreaterThan(-1);
    expect(out[brandAt + 1]).toMatch(/^\s+Reusable source of truth for brand identity/);
    const foundationAt = out.findIndex((l) => l.includes("Foundation") && l.includes(FOUNDATION));
    expect(out[foundationAt + 1]).toMatch(/^\s+Capture mission, audience and positioning\.$/);
  });

  it("--details: a populated space prints its purpose; an empty one does not repeat the same goal twice", async () => {
    h.payload = { ...lightPayload, detail: "full" };
    const { orient } = await import("../src/commands/data.js");
    await orient({ details: true });
    const out = plain();
    expect(out.filter((l) => l.includes("Reusable source of truth for brand"))).toHaveLength(1);
    // Goal === purpose ⇒ printed once, not again as "→ onboard:".
    expect(out.filter((l) => l.includes("Capture mission, audience"))).toHaveLength(1);
    expect(h.calls).toEqual([["/orient", { detail: "full" }]]);
  });

  it("an older pod that sends only onboarding.goal still gets a purpose line", async () => {
    h.payload = {
      ...lightPayload,
      workspaces: [{ id: FOUNDATION, name: "Foundation", domain: null, entityCount: 3, onboarding: { goal: "The goal." } }],
    };
    const { orient } = await import("../src/commands/data.js");
    await orient({});
    expect(plain().some((l) => /^\s+The goal\.$/.test(l))).toBe(true);
  });

  it("prints the pinned space's brief when present, and says so when it could not be read", async () => {
    h.payload = {
      ...lightPayload,
      brief: {
        workspaceId: BRAND,
        name: "Brand Library",
        purpose: "Reusable source of truth for brand identity.",
        persona: "THE BRAND STRATEGIST: Act as a seasoned brand strategist.",
        collect: [{ kind: "brand-identity", cardinality: "one" }],
        keyKinds: [
          { slug: "brand-identity", entityCount: 1 },
          { slug: "brand-asset", entityCount: 0 },
        ],
        keyKindsTotal: 12,
        playbooks: { status: "unavailable" },
        more: "More: list_playbooks …",
      },
    };
    const { orient } = await import("../src/commands/data.js");
    await orient({});
    const out = plain().join("\n");
    expect(out).toContain("Space brief — Brand Library");
    expect(out).toContain("persona: THE BRAND STRATEGIST");
    expect(out).toContain("kinds: brand-identity (1), brand-asset (0) …+10");
    expect(out).toContain("collect: brand-identity (one)");
    expect(out).toContain("playbooks: unavailable (read failed)");

    lines = [];
    h.payload = { ...lightPayload, brief: { status: "unavailable" } };
    await orient({});
    expect(plain().join("\n")).toContain("Space brief: unavailable");
  });

  it("no brief key ⇒ no brief section", async () => {
    h.payload = lightPayload;
    const { orient } = await import("../src/commands/data.js");
    await orient({});
    expect(plain().join("\n")).not.toContain("Space brief");
  });
});
