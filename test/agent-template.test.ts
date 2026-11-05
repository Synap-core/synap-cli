/**
 * D9: `synap agents add` names the agent's template, read from the INSTALLED
 * catalog (`agents/*.agent.yaml`), and sends it on the ONE connect request
 * (`POST /api/hub/setup/agent` `template`): the pod applies it with the same
 * approval that connects the agent.
 *
 * Pinned: a type the catalog names sends its slug (an alias too, and a slug
 * that differs from the type); a type the catalog does not name, two
 * templates claiming one type, or a catalog without `agents/` send none;
 * the request carries it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let root: string;

function writeAgent(file: string, slug: string, harness: string, aliases: string[] = []) {
  fs.mkdirSync(path.join(root, "agents"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "agents", file),
    [
      "apiVersion: synap/v1",
      "kind: agent",
      `meta: { slug: ${slug}, name: X }`,
      "spec:",
      `  harness: ${harness}`,
      `  aliases: [${aliases.join(", ")}]`,
      "  worker: false",
      "  tried: true",
      "",
    ].join("\n"),
  );
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "synap-catalog-agents-"));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("agentTemplateFor — the installed catalog names the template", () => {
  it("by harness, by alias, and a slug that differs from the type", async () => {
    const { agentTemplateFor, installedAgentTemplates } = await import("../src/lib/agent-template.js");
    writeAgent("claude-code.agent.yaml", "claude-code", "claude-code", ["claude"]);
    writeAgent("proton-agent.agent.yaml", "proton-agent", "proton");
    const t = installedAgentTemplates(root);
    expect(agentTemplateFor("claude-code", t)).toBe("claude-code");
    expect(agentTemplateFor("claude", t)).toBe("claude-code");
    expect(agentTemplateFor("proton", t)).toBe("proton-agent");
  });

  it("names none for an unknown type, two claimants, or a catalog without agents/", async () => {
    const { agentTemplateFor, installedAgentTemplates } = await import("../src/lib/agent-template.js");
    expect(installedAgentTemplates(root)).toEqual([]);
    expect(installedAgentTemplates(null)).toEqual([]);
    writeAgent("a.agent.yaml", "a", "shared");
    writeAgent("b.agent.yaml", "b", "shared");
    const t = installedAgentTemplates(root);
    expect(agentTemplateFor("shared", t)).toBeNull();
    expect(agentTemplateFor("eve", t)).toBeNull();
  });
});

describe("provisionAgentKey sends the template on the one connect request", () => {
  async function mintWith(templates: Array<{ slug: string; types: string[] }>) {
    vi.doMock("../src/lib/agent-template.js", () => ({
      agentTemplateFor: (type: string) => templates.find((t) => t.types.includes(type))?.slug ?? null,
    }));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "synap-tpl-home-"));
    vi.stubEnv("HOME", home);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
        if (url.endsWith("/api/hub/setup/agent")) {
          bodies.push(JSON.parse(String(init!.body)));
          return json({ hubApiKey: "k", agentUserId: "agent-1" });
        }
        if (url.endsWith("/api/hub/auth/key-state")) return json({ state: "active" });
        return json({});
      }),
    );
    const { provisionAgentKey } = await import("../src/lib/targets.js");
    return { provisionAgentKey, bodies };
  }

  it("a type the catalog names carries its template", async () => {
    const { provisionAgentKey, bodies } = await mintWith([{ slug: "proton-agent", types: ["proton"] }]);
    await provisionAgentKey("https://pod.example.test", "human-key", "proton", { requireApproval: false });
    expect(bodies[0]).toMatchObject({ agentType: "proton", template: "proton-agent" });
  });

  it("a type it does not name sends no template at all", async () => {
    const { provisionAgentKey, bodies } = await mintWith([]);
    await provisionAgentKey("https://pod.example.test", "human-key", "eve", { requireApproval: false });
    expect(bodies[0]).toMatchObject({ agentType: "eve" });
    expect(bodies[0]).not.toHaveProperty("template");
  });
});
