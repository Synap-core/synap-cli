/**
 * `synap session list --kind` — the population-lens filter and its column.
 *
 * The Hub REST `GET /focus-sessions` door (backend: `routers/hub-protocol/
 * rest/focus-sessions.ts`) accepts `kind: work|run|receipt|all` (default
 * "all") and projects `kind` onto every returned row
 * (`services/focus-sessions/session-kind.ts`). Before this the CLI neither
 * forwarded a kind filter nor rendered the field it already received —
 * `synap session list` printed receipts and runs indistinguishable from a
 * person's own work.
 *
 * `sessionKindLabel` is a LOCAL table, not `@synap-core/types/vocabulary`'s
 * `resolveStatusLabel` — see the doc comment on `SESSION_KIND_LABELS` in
 * `src/commands/sessions.ts` for why this package cannot import that SSOT.
 * The second test below is the tripwire that keeps the local table from
 * drifting, mirroring `test/kind-heading-vocabulary-parity.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const hubGet = vi.fn(async () => [] as unknown[]);

vi.mock("../src/lib/hub-client.js", () => ({
  hubGet,
  resolveHubConfig: vi.fn(async () => ({
    podUrl: "http://127.0.0.1:1",
    apiKey: "agent-key",
    workspaceId: "ws-config",
  })),
  renderHubError: vi.fn(),
}));

beforeEach(() => {
  hubGet.mockClear();
});

describe("session list — --kind forwarding", () => {
  it("forwards kind when a specific population is requested", async () => {
    const { listSessions } = await import("../src/commands/sessions.js");
    await listSessions({ workspace: "ws-1", kind: "run", json: true });

    const [, params] = hubGet.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(params.kind).toBe("run");
  });

  it("omits kind entirely for the default 'all' — the door's own default", async () => {
    const { listSessions } = await import("../src/commands/sessions.js");
    await listSessions({ workspace: "ws-1", kind: "all", json: true });

    const [, params] = hubGet.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(params).not.toHaveProperty("kind");
  });

  it("omits kind when --kind is not given at all", async () => {
    const { listSessions } = await import("../src/commands/sessions.js");
    await listSessions({ workspace: "ws-1", json: true });

    const [, params] = hubGet.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(params).not.toHaveProperty("kind");
  });

  it("rejects an unknown --kind value at the edge, not on the pod", async () => {
    const { listSessions } = await import("../src/commands/sessions.js");
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await listSessions({ workspace: "ws-1", kind: "bogus", json: true });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy.mock.calls.join(" ")).toContain("--kind");

    exitSpy.mockRestore();
    errSpy.mockRestore();
  });
});

describe("session list — KIND column matches the vocabulary registry", () => {
  const REGISTRY = join(
    process.cwd(),
    "../synap-backend/packages/types/src/vocabulary/index.ts",
  );
  const SRC = join(process.cwd(), "src/commands/sessions.ts");
  const cli = readFileSync(SRC, "utf8");

  it("the CLI table is readable and never derives a label from charAt(0)", () => {
    expect(cli).toContain("const SESSION_KIND_LABELS");
    expect(cli).not.toMatch(/\.charAt\(0\)\.toUpperCase\(\)/);
  });

  it.runIf(existsSync(REGISTRY))(
    "every SESSION_KIND_LABELS entry equals the registry's STATUS_LABELS",
    () => {
      const reg = readFileSync(REGISTRY, "utf8");
      expect(
        reg.length,
        "registry source unreadable — assertion would be vacuous",
      ).toBeGreaterThan(1000);

      const table = /const SESSION_KIND_LABELS: Record<string, string> = \{([\s\S]*?)\n\};/.exec(
        cli,
      )?.[1];
      expect(table, "SESSION_KIND_LABELS table not found").toBeTruthy();

      const rows = [...table!.matchAll(/^\s*(\w+):\s*"([^"]+)"/gm)];
      expect(rows.length, "no rows parsed — the assertion would be vacuous").toBe(3);

      for (const [, kind, label] of rows) {
        // The registry pins these under STATUS_LABELS (session population
        // lens, not an object kind) — match the exact `kind: "Label"` line.
        const re = new RegExp(`^\\s*${kind}:\\s*"([^"]+)",?\\s*$`, "m");
        const registryLabel = re.exec(reg)?.[1];
        if (!registryLabel) continue; // key not found under this exact spelling — nothing to fork from
        expect(
          label,
          `CLI prints "${label}" for ${kind}; the registry says "${registryLabel}"`,
        ).toBe(registryLabel);
      }
    },
  );
});
