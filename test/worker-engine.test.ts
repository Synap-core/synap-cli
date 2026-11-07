/**
 * `synap worker` runs whatever program the agent's TEMPLATE wakes with, not
 * only Claude Code. The engine is read from the pod's roster (which template)
 * and the installed catalog (how it wakes); a program run is driven end to end
 * here through `createWorker`, with a fake program (a real child process) and
 * a stubbed pod MCP. What is asserted is what the worker DID: the argv it
 * started, the environment, and what the session heard when the run ended.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorker } from "../src/commands/worker.js";
import {
  checkEnginePin,
  enginePinPath,
  engineFor,
  renderWakeArgs,
  resolveWorkerEngine,
  rosterTemplateSlug,
  writeEnginePin,
  type WorkerEngine,
} from "../src/commands/worker-engine.js";
import { readAgentTemplateWake, type AgentTemplateWake } from "../src/lib/agent-template.js";
import { resolveInstalledCatalogRoot } from "../src/lib/catalog-templates.js";
import type { McpCallClient } from "../src/lib/mcp-call.js";

const SELF = "a9a9a9a9-0000-4000-8000-000000000009";
const SID = "55555555-5555-4555-8555-555555555555";

let tmp: string;
let runLog: string;

const HERMES_YAML = `apiVersion: synap/v1
kind: agent
meta:
  slug: hermes
  name: "Hermes Agent"
spec:
  harness: hermes
  worker: true
  tried: false
  wake:
    program: hermes
    args: ["chat", "-q", "{prompt}"]
    params:
      prompt: { type: text, required: true }
    env:
      strip: [SYNAP_FAKE_STRIP]
`;

/** A program engine stand-in: logs its argv, cwd and one env name, then says what FAKE_MODE asks. */
const FAKE = `#!/usr/bin/env node
const fs = require("fs");
fs.appendFileSync(process.env.SYNAP_FAKE_RUN_LOG, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), strip: process.env.SYNAP_FAKE_STRIP ?? null }) + "\\n");
const mode = process.env.SYNAP_FAKE_MODE;
if (mode === "hang") { setTimeout(() => {}, 60000); return; }
process.stdout.write("thinking about it\\n");
if (mode === "prose") { process.stdout.write("Here is my answer, no verdict line.\\n"); return; }
if (mode === "crash") { process.stderr.write("boom\\n"); process.exit(3); }
process.stdout.write("WORKER-RESULT: done — said hello\\n");
`;

const fakeRuns = () =>
  fs.existsSync(runLog)
    ? fs.readFileSync(runLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv: string[]; cwd: string; strip: string | null })
    : [];

function writeCatalog(yaml: string = HERMES_YAML): string {
  const root = path.join(tmp, "catalog");
  fs.mkdirSync(path.join(root, "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, "agents", "hermes.agent.yaml"), yaml);
  return root;
}

function programEngine(programPath: string, catalogRoot = writeCatalog()): WorkerEngine {
  const tpl = readAgentTemplateWake("hermes", catalogRoot)!;
  return engineFor("hermes-mac", "hermes", tpl, path.dirname(programPath));
}

/** The pod: one handed session, its room, every post recorded. */
function stubPod(posts: Array<Record<string, unknown>>): McpCallClient {
  return {
    async call(tool, args = {}) {
      if (tool === "synap_orient") {
        return { isError: false, text: JSON.stringify({ startHere: { handedToYou: { count: 1, items: [{ id: SID, goal: "say hello" }] } } }) };
      }
      if (tool === "synap_get_session") {
        return {
          isError: false,
          text: JSON.stringify({
            // A playbook run over pod data: the work-folder protocol (what the person's Mac takes).
            session: { id: SID, goal: "say hello", playbookId: "pb-hello", channelId: "room-1", metadata: { prompt: "Say hello", params: {} } },
            outcomes: { status: "ok", outcomes: [] },
          }),
        };
      }
      if (tool === "synap_post_message") {
        posts.push(args);
        return { isError: false, text: "{}" };
      }
      if (tool === "synap_get_thread_context") return { isError: false, text: JSON.stringify({ messages: [] }) };
      throw new Error(`unexpected tool ${tool}`);
    },
  };
}

async function runOnce(engine: WorkerEngine, extra: { runTimeout?: string } = {}) {
  const posts: Array<Record<string, unknown>> = [];
  const code = path.join(tmp, "code");
  fs.mkdirSync(code, { recursive: true });
  const w = createWorker(
    {
      agent: "hermes-mac",
      cwd: code,
      workRoot: path.join(tmp, "work"),
      protocols: "work-folder",
      // Never the real claude: were the Claude path taken, it would fail to start, not run a model.
      claudeBin: path.join(tmp, "bin", "not-claude"),
      engine,
      ...extra,
    },
    { mcp: stubPod(posts), podUrl: "https://pod.example", apiKey: "k", selfAgentId: SELF, say: () => {} }
  );
  await w.tick();
  await w.waitForChildren();
  return { w, posts };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "worker-engine-"));
  runLog = path.join(tmp, "runs.log");
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "hermes"), FAKE, { mode: 0o755 });
  // The worker's state (which sessions it already ran) lives under the test file's HOME: each test starts fresh.
  fs.rmSync(path.join(os.homedir(), ".synap"), { recursive: true, force: true });
  vi.stubEnv("SYNAP_FAKE_RUN_LOG", runLog);
  vi.stubEnv("SYNAP_FAKE_STRIP", "must-not-reach-the-run");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const hermesBin = () => path.join(tmp, "bin", "hermes");

describe("a program engine runs end to end", () => {
  it("starts the template's program with its argv rendered, in the run's folder, without the stripped env; its verdict ends the run", async () => {
    vi.stubEnv("SYNAP_FAKE_MODE", "done");
    const { w, posts } = await runOnce(programEngine(hermesBin()));

    const runs = fakeRuns();
    expect(runs).toHaveLength(1);
    const [verb, flag, prompt] = runs[0].argv;
    expect([verb, flag]).toEqual(["chat", "-q"]);
    expect(runs[0].argv).toHaveLength(3);
    expect(prompt).toContain(`Session: ${SID}`);
    expect(prompt).not.toContain("{prompt}");
    expect(fs.realpathSync(runs[0].cwd)).toBe(fs.realpathSync(path.join(tmp, "work", SID)));
    expect(runs[0].strip).toBeNull();

    expect(w.state.runs[SID]).toMatchObject({ status: "done", exitCode: 0, result: "done — said hello", mode: "print" });
    expect(posts.map((p) => p.content)).toEqual(["Result: done — said hello"]);
    // What it printed is in the run log.
    const log = fs.readFileSync(path.join(os.homedir(), ".synap", "worker", "hermes-mac", "runs", `${SID}.jsonl`), "utf8");
    expect(log).toContain("thinking about it");
  });

  it("a clean exit with no verdict line tells the room what it printed, as blocked (never a done on prose)", async () => {
    vi.stubEnv("SYNAP_FAKE_MODE", "prose");
    const { w, posts } = await runOnce(programEngine(hermesBin()));
    expect(w.state.runs[SID].status).toBe("done");
    expect(posts).toHaveLength(1);
    expect(posts[0].content).toMatch(/^Result: blocked — hermes ended without a WORKER-RESULT line; it printed: .*no verdict line\./);
  });

  it("a non-zero exit fails the run and says so", async () => {
    vi.stubEnv("SYNAP_FAKE_MODE", "crash");
    const { w, posts } = await runOnce(programEngine(hermesBin()));
    expect(w.state.runs[SID]).toMatchObject({ status: "failed", exitCode: 3 });
    expect(posts[0].content).toMatch(/^Result: failed — the run exited 3 without a verdict/);
  });

  it("a run past --run-timeout is stopped and fails", async () => {
    vi.stubEnv("SYNAP_FAKE_MODE", "hang");
    const { w, posts } = await runOnce(programEngine(hermesBin()), { runTimeout: "300ms" });
    expect(w.state.runs[SID].status).toBe("failed");
    expect(w.state.runs[SID].result).toMatch(/^stopped after 300ms \(--run-timeout\): hermes did not finish/);
    expect(posts[0].content).toMatch(/^Result: failed — .*stopped after 300ms/);
  });
});

describe("which engine, and why not", () => {
  it("reads the slug the pod's roster names for THIS agent; a roster that does not list it, or cannot be read, throws", () => {
    const roster = (agents: unknown[]) => JSON.stringify({ agents, computers: [] });
    expect(rosterTemplateSlug(roster([{ agentUserId: "other", template: { slug: "codex" } }, { agentUserId: SELF, template: { slug: "hermes" } }]), SELF)).toBe("hermes");
    expect(rosterTemplateSlug(roster([{ agentUserId: SELF, template: null }]), SELF)).toBeNull();
    expect(() => rosterTemplateSlug(roster([{ agentUserId: "other" }]), SELF)).toThrow(/does not list this agent/);
    expect(() => rosterTemplateSlug("not json", SELF)).toThrow(/could not be read/);
  });

  it("the roster read goes through synap_list_agents; a refused read is said, never a fallback", async () => {
    const tpl = (slug: string): AgentTemplateWake | null => (slug === "hermes" ? readAgentTemplateWake("hermes", writeCatalog()) : null);
    const ok: McpCallClient = {
      call: async (tool) => {
        expect(tool).toBe("synap_list_agents");
        return { isError: false, text: JSON.stringify({ agents: [{ agentUserId: SELF, template: { slug: "hermes" } }] }) };
      },
    };
    const e = await resolveWorkerEngine("hermes-mac", ok, SELF, path.join(tmp, "bin"), tpl);
    expect(e).toMatchObject({ kind: "program", template: "hermes", program: "hermes", programPath: hermesBin() });
    const refused: McpCallClient = { call: async () => ({ isError: true, text: "forbidden" }) };
    await expect(resolveWorkerEngine("hermes-mac", refused, SELF, path.join(tmp, "bin"), tpl)).rejects.toThrow(/roster could not be read: forbidden/);
  });

  it("the pod's served wake block is the source; the catalog answers only an older pod or a built-in template", async () => {
    const bin = path.join(tmp, "bin");
    // A catalog whose hermes block differs from the pod's: which one ran tells the source.
    const catalog = (slug: string) =>
      slug === "hermes"
        ? readAgentTemplateWake("hermes", writeCatalog(HERMES_YAML.replace('["chat", "-q", "{prompt}"]', '["old", "{prompt}"]')))
        : null;
    const roster = (template: Record<string, unknown>): McpCallClient => ({
      call: async () => ({ isError: false, text: JSON.stringify({ agents: [{ agentUserId: SELF, template }] }) }),
    });
    const podWake = { program: "hermes", args: ["chat", "-q", "{prompt}"], params: { prompt: { type: "text", required: true } } };

    const fromPod = await resolveWorkerEngine("h", roster({ slug: "hermes", version: "h-1", wake: podWake }), SELF, bin, catalog);
    expect(fromPod).toMatchObject({ kind: "program", source: "pod", version: "h-1", wake: { args: ["chat", "-q", "{prompt}"] } });

    // A pod older than the field (no `wake` key): this synap's catalog.
    const older = await resolveWorkerEngine("h", roster({ slug: "hermes", version: "h-1" }), SELF, bin, catalog);
    expect(older).toMatchObject({ source: "catalog", wake: { args: ["old", "{prompt}"] } });

    // An installed template the pod says has no wake: refused (never the catalog's block instead).
    await expect(resolveWorkerEngine("h", roster({ slug: "hermes", version: "h-1", wake: null }), SELF, bin, catalog)).rejects.toThrow(/has no wake/);

    // A served block that is not one, or names a path instead of a program: refused.
    await expect(resolveWorkerEngine("h", roster({ slug: "hermes", version: "h-1", wake: { program: 7 } }), SELF, bin, catalog)).rejects.toThrow(/not one/);
    await expect(
      resolveWorkerEngine("h", roster({ slug: "hermes", version: "h-1", wake: { ...podWake, program: "/tmp/evil" } }), SELF, bin, catalog)
    ).rejects.toThrow(/not a bare program name/);

    // The built-in Claude Code template (version null, wake null): the Claude path.
    const claude = await resolveWorkerEngine("c", roster({ slug: "claude-code", version: null, wake: null }), SELF, bin, () => null);
    expect(claude).toMatchObject({ kind: "claude", source: "catalog" });
  });

  it("a missing program is refused by name", () => {
    const tpl = readAgentTemplateWake("hermes", writeCatalog())!;
    expect(() => engineFor("hermes-mac", "hermes", tpl, "/nowhere")).toThrow(/^hermes is not installed here/);
  });

  it("Claude Code keeps its own path; no template, a template without a wake, or one this catalog lacks are refused", () => {
    expect(engineFor("a", "claude-code", { slug: "claude-code", harness: "claude-code", wake: null }, "")).toEqual({ kind: "claude", template: "claude-code" });
    // The pod's built-in claude-code on a catalog package from before agent templates.
    expect(engineFor("a", "claude-code", null, "")).toEqual({ kind: "claude", template: "claude-code" });
    expect(() => engineFor("a", null, null, "")).toThrow(/names no agent template/);
    expect(() => engineFor("a", "goose", { slug: "goose", harness: "goose", wake: null }, "")).toThrow(/has no wake/);
    expect(() => engineFor("a", "mystery", null, "")).toThrow(/not in the catalog installed with this synap/);
  });

  it("renders every placeholder or refuses: never a literal {prompt}", () => {
    const wake = { program: "x", args: ["run", "--q={prompt}", "{prompt}"], params: { prompt: { required: true } }, envStrip: [] };
    expect(renderWakeArgs(wake, { prompt: "hi {there}" })).toEqual(["run", "--q=hi {there}", "hi {there}"]);
    expect(() => renderWakeArgs(wake, {})).toThrow(/needs the param "prompt"/);
    expect(() => renderWakeArgs({ ...wake, args: ["{model}"], params: {} }, { prompt: "p" })).toThrow(/needs \{model\}/);
  });

  it("a wake block that cannot be read throws (not 'no wake')", () => {
    const root = writeCatalog(HERMES_YAML.replace("program: hermes", "program: 7"));
    expect(() => readAgentTemplateWake("hermes", root)).toThrow(/cannot read/);
  });

  it("reads the real installed catalog's templates (non-vacuity)", () => {
    const root = resolveInstalledCatalogRoot();
    expect(root).not.toBeNull();
    // The lockfile may pin a catalog from before agent templates (0.23.0 has no agents/): then it names
    // none, and the worker's reader falls back to the pod or refuses. A catalog with agents/ must read.
    if (!fs.existsSync(path.join(root!, "agents"))) {
      expect(readAgentTemplateWake("claude-code", root)).toBeNull();
      return;
    }
    expect(readAgentTemplateWake("claude-code", root)).toMatchObject({ harness: "claude-code", wake: { program: "claude" } });
    expect(readAgentTemplateWake("hermes", root)?.wake?.args).toContain("{prompt}");
  });
});

describe("the pin: this computer runs only the command it agreed to", () => {
  const hermes = (over: Partial<{ args: string[]; programPath: string; version: string | null; template: string }> = {}): WorkerEngine => ({
    kind: "program",
    template: over.template ?? "hermes",
    program: "hermes",
    programPath: over.programPath ?? hermesBin(),
    wake: { program: "hermes", args: over.args ?? ["chat", "-q", "{prompt}"], params: {}, envStrip: [] },
    version: over.version === undefined ? "h-1" : over.version,
    source: "pod",
  });

  it("the first run records it; the same command runs; a version bump alone runs and moves the pin", () => {
    const home = os.homedir();
    expect(checkEnginePin(home, "hermes-mac", hermes())).toEqual({ status: "pinned" });
    const file = enginePinPath(home, "hermes-mac");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({
      template: "hermes",
      program: "hermes",
      programPath: hermesBin(),
      args: ["chat", "-q", "{prompt}"],
      version: "h-1",
    });
    expect(checkEnginePin(home, "hermes-mac", hermes())).toEqual({ status: "same" });
    expect(checkEnginePin(home, "hermes-mac", hermes({ version: "h-2" }))).toEqual({ status: "version", from: "h-1", to: "h-2" });
    expect(JSON.parse(fs.readFileSync(file, "utf8")).version).toBe("h-2");
  });

  it("a changed wake on the pod is REFUSED with both commands and how to accept it; install accepts", () => {
    const home = os.homedir();
    checkEnginePin(home, "hermes-mac", hermes());
    const changed = hermes({ args: ["chat", "--yolo", "-q", "{prompt}"] });
    expect(() => checkEnginePin(home, "hermes-mac", changed)).toThrow(
      /^hermes-mac's wake changed on your pod \(hermes: .*hermes chat -q \{prompt\} → hermes: .*hermes chat --yolo -q \{prompt\}\)\. .*run `synap worker install --agent hermes-mac` again to accept it\.$/
    );
    // Another program path, another template, or a switch from Claude Code: refused too.
    expect(() => checkEnginePin(home, "hermes-mac", hermes({ programPath: "/opt/other/hermes" }))).toThrow(/wake changed/);
    expect(() => checkEnginePin(home, "hermes-mac", hermes({ template: "evil" }))).toThrow(/wake changed/);
    writeEnginePin(home, "claude-mac", { kind: "claude", template: "claude-code" });
    expect(() => checkEnginePin(home, "claude-mac", hermes())).toThrow(/claude-mac's wake changed on your pod \(claude-code: Claude Code → hermes:/);
    // Install is the person accepting it: the new command then runs.
    writeEnginePin(home, "hermes-mac", changed);
    expect(checkEnginePin(home, "hermes-mac", changed)).toEqual({ status: "same" });
  });

  it("an unreadable pin is refused, never silently re-pinned", () => {
    const home = os.homedir();
    const file = enginePinPath(home, "hermes-mac");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{not json");
    expect(() => checkEnginePin(home, "hermes-mac", hermes())).toThrow(/cannot be read/);
  });
});
