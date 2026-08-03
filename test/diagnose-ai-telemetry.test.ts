/**
 * The ONE line this whole wave exists for.
 *
 * 2026-08-03: an `ai.generate` step ran 24.5s, returned "", and reported
 * `completed`. `synap diagnose` printed `out (empty)` and could say nothing
 * more, so the operator had to SSH to the IS container (CT103) and grep
 * unstructured logs by wall-clock timestamp. These assertions pin the rendered
 * node line so that regression is visible in CI, not in a debugging session.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import chalk from "chalk";
import { renderNode } from "../src/commands/diagnose.js";

// Assert on TEXT, not on ANSI escapes — the point is what a human reads.
const prevLevel = chalk.level;
let lines: string[] = [];
let spy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  chalk.level = 0;
  lines = [];
  spy = vi
    .spyOn(console, "log")
    .mockImplementation((...args: unknown[]) => void lines.push(args.join(" ")));
});

afterEach(() => {
  spy.mockRestore();
  chalk.level = prevLevel;
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const step = (detail: Record<string, unknown>, status = "completed"): any => ({
  id: "s1",
  at: "2026-08-03T14:02:11.000Z",
  kind: "step",
  status,
  label: "analyze",
  hint: null,
  detail: { nodeId: "analyze", nodeType: "capability", ...detail },
});

describe("diagnose — AI telemetry on the node line", () => {
  it("explains an empty generation in one line", () => {
    renderNode(
      step({
        output: "",
        finishReason: "length",
        tokensIn: 4210,
        tokensOut: 0,
      })
    );
    const out = lines.find((l) => l.includes("out"));
    expect(out).toBe("            out (empty) · finish=length · tokens 4210→0");
  });

  it("appends telemetry to a NON-empty output too", () => {
    renderNode(
      step({
        output: { verdict: "ok" },
        finishReason: "stop",
        tokensIn: 900,
        tokensOut: 120,
      })
    );
    const out = lines.find((l) => l.includes("out"));
    expect(out).toContain('{"verdict":"ok"}');
    expect(out).toContain("finish=stop · tokens 900→120");
  });

  it("still shows the finish reason on a FAILED step that has no output key", () => {
    renderNode(
      step({ finishReason: "content-filter", tokensIn: 300, tokensOut: 0 }, "failed")
    );
    expect(lines.some((l) => l.includes("ai  finish=content-filter"))).toBe(true);
  });

  it("shows (empty) + telemetry on a FAILED step whose generation was empty", () => {
    renderNode(
      step({ output: "", finishReason: "length", tokensIn: 4210, tokensOut: 0 }, "failed")
    );
    const out = lines.find((l) => l.includes("out"));
    expect(out).toBe("            out (empty) · finish=length · tokens 4210→0");
  });

  it("prints nothing extra for a non-AI step (no fabricated zeros)", () => {
    renderNode(step({ output: { count: 3 } }));
    expect(lines.join("\n")).not.toContain("finish=");
    expect(lines.join("\n")).not.toContain("tokens");
  });

  it("renders a partial report when the provider gave only some numbers", () => {
    renderNode(step({ output: "", finishReason: "error" }));
    const out = lines.find((l) => l.includes("out"));
    expect(out).toBe("            out (empty) · finish=error");
  });
});
