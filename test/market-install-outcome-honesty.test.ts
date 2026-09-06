/**
 * Unit tests for `summarizeItemInstall` — the pure per-item classifier that
 * lets `synap market install <workflow-slug>` report the REAL outcome instead
 * of a bare "✓ Installed". The backend `market.install` automation case
 * installs each automation under its own try/catch (per-item isolation), so the
 * verb can report `{status:"installed"}` overall while individual items are
 * `{status:"error"}` — this classifier is what surfaces that, and what the
 * command layer uses to exit non-zero when NOTHING was created.
 */
import { describe, it, expect } from "vitest";
import { summarizeItemInstall } from "../src/commands/market.js";

describe("summarizeItemInstall", () => {
  it("returns null for a kind carrying no per-item array (cell/skill/view)", () => {
    expect(summarizeItemInstall({ kind: "cell", created: true })).toBeNull();
    expect(summarizeItemInstall({ kind: "view", created: 1, updated: 0, failed: 0 })).toBeNull();
    expect(summarizeItemInstall({})).toBeNull();
  });

  it("counts created / reused / error across the automations[] array", () => {
    const s = summarizeItemInstall({
      kind: "automation",
      automations: [
        { name: "a", status: "created", id: "1" },
        { name: "b", status: "reused", id: "2" },
        { name: "c", status: "error", message: "boom" },
      ],
    });
    expect(s).not.toBeNull();
    expect(s!.created).toBe(1);
    expect(s!.reused).toBe(1);
    expect(s!.errored.map((e) => e.name)).toEqual(["c"]);
    expect(s!.errored[0].message).toBe("boom");
    // created + reused > 0 → a partial install, caller stays exit 0.
    expect(s!.okCount).toBe(2);
  });

  it("okCount is 0 when EVERY item errored (the total-failure / non-zero-exit case)", () => {
    const s = summarizeItemInstall({
      kind: "automation",
      automations: [
        { name: "a", status: "error", message: "x" },
        { name: "b", status: "error", message: "y" },
      ]!,
    });
    expect(s!.okCount).toBe(0);
    expect(s!.errored).toHaveLength(2);
  });

  it("reused-only (no created, no error) is a success — okCount > 0", () => {
    const s = summarizeItemInstall({
      kind: "automation",
      automations: [{ name: "a", status: "reused", id: "1" }],
    });
    expect(s!.okCount).toBe(1);
    expect(s!.errored).toHaveLength(0);
  });

  it("reads a generic results[] array too (not only automations[])", () => {
    const s = summarizeItemInstall({
      results: [
        { name: "a", status: "created" },
        { name: "b", status: "error", message: "z" },
      ],
    });
    expect(s!.created).toBe(1);
    expect(s!.errored).toHaveLength(1);
  });
});
