/**
 * The transcript index: what a conversation has running in the background,
 * from the transcript JSONL, read incrementally.
 *
 * Fixture lines mirror Claude Code 2.1.x transcripts (shapes taken from real
 * transcripts on 2026-10-29: a Bash `backgroundTaskId` result, an Agent
 * `async_launched` result, a `teammate_spawned` result, `<task-notification>`
 * user messages, a SendMessage `resumedAgentId` result, a TaskStop).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { applyLine, emptyIndex, updateIndex, type TranscriptIndex } from "./transcript-index.js";

const T0 = Date.parse("2026-10-29T10:00:00.000Z");
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();

function toolUse(id: string, name: string, input: Record<string, unknown>, s = 0): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: iso(s),
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
  });
}
function toolResult(id: string, toolUseResult: unknown, text = "ok", s = 1): string {
  return JSON.stringify({
    type: "user",
    timestamp: iso(s),
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] },
    toolUseResult,
  });
}
function notification(taskIds: string[], status: string, s: number, summary = "done"): string {
  const ids = taskIds.map((t) => `<task-id>${t}</task-id>`).join("\n");
  return JSON.stringify({
    type: "user",
    timestamp: iso(s),
    message: { role: "user", content: `<task-notification>\n${ids}\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>` },
  });
}
function teammateIdle(from: string, s: number): string {
  const body = JSON.stringify({ type: "idle_notification", from, timestamp: iso(s), idleReason: "available" });
  return JSON.stringify({
    type: "user",
    timestamp: iso(s),
    message: { role: "user", content: `<teammate-message teammate_id="${from}" color="blue">\n${body}\n</teammate-message>` },
  });
}

function apply(lines: string[], idx: TranscriptIndex = emptyIndex("/t.jsonl")): TranscriptIndex {
  for (const l of lines) applyLine(idx, l, T0);
  return idx;
}

describe("background tasks open and close", () => {
  it("a Bash launch opens on its backgroundTaskId result and closes on its notification", () => {
    const idx = apply([
      toolUse("toolu_1", "Bash", { command: "synap wait devbox w7", description: "Wait for w7", run_in_background: true }),
      toolResult("toolu_1", { stdout: "", backgroundTaskId: "bx1" }, "Command running in background with ID: bx1."),
    ]);
    expect(Object.keys(idx.open)).toEqual(["bx1"]);
    expect(idx.open.bx1).toMatchObject({ kind: "bash", description: "Wait for w7", command: "synap wait devbox w7", startedAt: T0 });
    expect(idx.pending).toEqual({});

    apply([notification(["bx1"], "completed", 60)], idx);
    expect(idx.open).toEqual({});
    expect(idx.recentlyClosed.at(-1)).toMatchObject({ taskId: "bx1", status: "completed", closedAt: T0 + 60_000 });
  });

  it("a foreground Bash that finishes normally opens nothing", () => {
    const idx = apply([toolUse("toolu_2", "Bash", { command: "ls" }), toolResult("toolu_2", { stdout: "a\nb" })]);
    expect(idx.open).toEqual({});
    expect(idx.pending).toEqual({});
  });

  it("a foreground Bash moved to the background by its timeout opens too", () => {
    const idx = apply([
      toolUse("toolu_3", "Bash", { command: "pnpm test", description: "Run tests" }),
      toolResult("toolu_3", { stdout: "", backgroundTaskId: "bmoved" }, "Command did not complete within its 120s timeout and was moved to the background"),
    ]);
    expect(idx.open.bmoved?.description).toBe("Run tests");
  });

  it("an async Agent opens on async_launched and a TaskStop closes it", () => {
    const idx = apply([
      toolUse("toolu_4", "Agent", { description: "Audit the flow", prompt: "…" }),
      toolResult("toolu_4", { isAsync: true, status: "async_launched", agentId: "a5ceb" }),
    ]);
    expect(idx.open.a5ceb).toMatchObject({ kind: "agent", description: "Audit the flow" });
    apply([toolUse("toolu_5", "TaskStop", { task_id: "a5ceb" }, 30)], idx);
    expect(idx.open).toEqual({});
    expect(idx.recentlyClosed.at(-1)).toMatchObject({ taskId: "a5ceb", status: "stopped" });
  });

  it("a resumed agent is open again, and its next notification closes it again (last event wins)", () => {
    const idx = apply([
      toolUse("toolu_6", "Agent", { description: "Draft the plan" }),
      toolResult("toolu_6", { status: "async_launched", agentId: "a48ea" }),
      notification(["a48ea"], "completed", 100),
      // Addressed by name: only the result's `resumedAgentId` says which task this is.
      toolUse("toolu_7", "SendMessage", { to: "drafter", message: "one more thing" }, 200),
      toolResult("toolu_7", { success: true, message: "Resuming agent a48ea", resumedAgentId: "a48ea" }, "ok", 201),
    ]);
    expect(idx.open.a48ea).toMatchObject({ kind: "agent", description: "Draft the plan", startedAt: T0 + 201_000 });
    apply([notification(["a48ea"], "completed", 300)], idx);
    expect(idx.open).toEqual({});
    expect(idx.recentlyClosed.filter((c) => c.taskId === "a48ea")).toHaveLength(1);
  });

  it("one notification can close several tasks, and its scan marker is not a task", () => {
    const idx = apply([
      toolUse("toolu_8", "Bash", { command: "sleep 100", run_in_background: true }),
      toolResult("toolu_8", { backgroundTaskId: "b1" }),
      toolUse("toolu_9", "Bash", { command: "sleep 200", run_in_background: true }),
      toolResult("toolu_9", { backgroundTaskId: "b2" }),
      notification(["b1", "b2", "__orphan_summary__:shell"], "stopped", 50),
    ]);
    expect(idx.open).toEqual({});
    expect(idx.recentlyClosed.map((c) => c.taskId)).toEqual(["b1", "b2"]);
  });

  it("a teammate is open while busy, closed on its idle notice, open again once messaged", () => {
    const idx = apply([
      toolUse("toolu_10", "Agent", { name: "nowline", description: "Build the now line" }),
      toolResult("toolu_10", { status: "teammate_spawned", agentId: "anowline-1", name: "nowline" }),
    ]);
    expect(idx.open["anowline-1"]).toMatchObject({ kind: "teammate", description: "@nowline" });
    apply([teammateIdle("nowline", 90)], idx);
    expect(idx.open).toEqual({});
    apply(
      [
        toolUse("toolu_11", "SendMessage", { to: "nowline", message: "next" }, 120),
        toolResult("toolu_11", { success: true, message: "Message sent to nowline's inbox" }, "ok", 121),
      ],
      idx
    );
    expect(idx.open["anowline-1"]?.startedAt).toBe(T0 + 121_000);
  });
});

describe("incremental read", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "synap-ti-"));
    file = path.join(dir, "s.jsonl");
  });

  const launch = (n: number) => [
    toolUse(`toolu_${n}`, "Bash", { command: `job ${n}`, description: `job ${n}`, run_in_background: true }),
    toolResult(`toolu_${n}`, { backgroundTaskId: `b${n}` }),
  ];

  it("reads only what was appended, and leaves a half-written line for next time", () => {
    fs.writeFileSync(file, launch(1).join("\n") + "\n");
    const first = updateIndex(null, file, { maxBytes: Infinity });
    expect(Object.keys(first.index.open)).toEqual(["b1"]);
    expect(first.index.offset).toBe(fs.statSync(file).size);

    const [use, result] = launch(2);
    fs.appendFileSync(file, use + "\n" + result.slice(0, 20)); // the result is mid-write
    const second = updateIndex(first.index, file, { maxBytes: Infinity });
    expect(second.index.pending.toolu_2).toBeDefined();
    expect(second.index.open.b2).toBeUndefined();

    fs.appendFileSync(file, result.slice(20) + "\n");
    const third = updateIndex(second.index, file, { maxBytes: Infinity });
    expect(Object.keys(third.index.open).sort()).toEqual(["b1", "b2"]);
    expect(third.index.offset).toBe(fs.statSync(file).size);
  });

  it("a transcript smaller than the offset (truncated or replaced) is read again from 0", () => {
    fs.writeFileSync(file, [...launch(1), ...launch(2)].join("\n") + "\n");
    const before = updateIndex(null, file, { maxBytes: Infinity });
    expect(Object.keys(before.index.open)).toHaveLength(2);

    fs.writeFileSync(file, launch(3).join("\n") + "\n"); // shorter
    const after = updateIndex(before.index, file, { maxBytes: Infinity });
    expect(Object.keys(after.index.open)).toEqual(["b3"]);
  });

  it("a backlog bigger than maxBytes is not read by render: it says how far behind it is", () => {
    fs.writeFileSync(file, launch(1).join("\n") + "\n");
    const r = updateIndex(null, file, { maxBytes: 10 });
    expect(r.behind).toBe(fs.statSync(file).size);
    expect(r.index.offset).toBe(0);
    expect(r.index.open).toEqual({});
  });

  it("reads a multi-chunk transcript line by line (lines straddling the 4 MB chunk edge)", () => {
    const filler = JSON.stringify({ type: "user", message: { content: "x".repeat(1_000_000) } });
    const lines = [...launch(1), filler, filler, filler, filler, filler, ...launch(2)];
    fs.writeFileSync(file, lines.join("\n") + "\n");
    const r = updateIndex(null, file, { maxBytes: Infinity });
    expect(Object.keys(r.index.open).sort()).toEqual(["b1", "b2"]);
    expect(r.index.offset).toBe(fs.statSync(file).size);
  });
});
