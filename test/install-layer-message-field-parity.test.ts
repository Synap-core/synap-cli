import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { printLayerOutcomes } from "../src/commands/market.js";

/**
 * THE FAILURE TEXT FIELD IS `message`, NOT `detail`.
 *
 * The CLI mirrors the pod's `InstallLayerReport` locally (it cannot import
 * `@synap/database`), and the mirror declared `detail` — a field NO producer
 * writes. So `printLayerOutcomes` printed "no detail reported" on every failed
 * layer while the pod had sent a real reason, and because both sides of the
 * drift were local, tsc could never see it. An existing test even pinned
 * `detail` as correct.
 *
 * Two halves, because either alone is defeatable: a BEHAVIOURAL assertion that
 * the message reaches the user, and a cross-repo source scan that fails if the
 * pod's SSOT ever renames the field out from under this mirror.
 */

const SSOT = join(
  process.cwd(),
  "../synap-backend/packages/database/src/utils/reconcile-workspace-from-definition.ts",
);
const SRC = join(process.cwd(), "src/commands/market.ts");

afterEach(() => vi.restoreAllMocks());

describe("printLayerOutcomes surfaces the pod's reason", () => {
  it("prints the layer's message, not a 'no detail reported' placeholder", () => {
    const errs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m?: unknown) => {
      errs.push(String(m));
    });
    printLayerOutcomes([
      { layer: "post-workspace", status: "failed", message: "3 item(s) failed to apply — cells" },
    ]);
    const joined = errs.join("\n");
    expect(joined).toContain("3 item(s) failed to apply — cells");
    expect(joined, "the reason was dropped and replaced by a placeholder").not.toContain(
      "no detail reported",
    );
  });

  it("still degrades honestly when a producer sent no message at all", () => {
    const errs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m?: unknown) => {
      errs.push(String(m));
    });
    printLayerOutcomes([{ layer: "template-reconcile", status: "failed" }]);
    expect(errs.join("\n")).toContain("no detail reported");
  });

  it("prints nothing when no layer failed", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    printLayerOutcomes([{ layer: "post-workspace", status: "applied" }]);
    printLayerOutcomes(undefined);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("the local mirror matches the pod's InstallLayerReport", () => {
  const hasSsot = existsSync(SSOT);

  it.runIf(hasSsot)("the pod declares `message` and no `detail`", () => {
    const ssot = readFileSync(SSOT, "utf8");
    expect(ssot.length, "SSOT unreadable — the assertion would be vacuous").toBeGreaterThan(1000);
    const at = ssot.indexOf("export interface InstallLayerReport");
    expect(at, "InstallLayerReport not found in the SSOT").toBeGreaterThan(-1);
    const block = ssot.slice(at, ssot.indexOf("\n}", at));
    expect(block).toMatch(/^\s*message\??:/m);
    expect(block, "the pod renamed the field — this mirror is now lying").not.toMatch(
      /^\s*detail\??:/m,
    );
  });

  it("the CLI mirror reads `message` and never reintroduces `detail`", () => {
    const cli = readFileSync(SRC, "utf8");
    const at = cli.indexOf("export interface InstallLayerReport");
    expect(at, "mirror not found").toBeGreaterThan(-1);
    const block = cli.slice(at, cli.indexOf("\n}", at));
    expect(block).toMatch(/^\s*message\??:/m);
    expect(block).not.toMatch(/^\s*detail\??:/m);
    // …and the reader must consume it. Comments stripped first so the docblock
    // explaining the fix cannot satisfy the assertion.
    const codeOnly = cli.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    expect(codeOnly.length, "stripper ate the file").toBeGreaterThan(5000);
    expect(codeOnly).toContain("l.message ??");
    expect(codeOnly).not.toContain("l.detail");
  });
});
