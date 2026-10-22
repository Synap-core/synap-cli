/**
 * `synap skill get` — the shape a script depends on: `--raw` prints the stored
 * body and nothing else (rules-from-pod.zsh renders .claude/rules files from
 * it), and a skill that does not exist exits non-zero.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const hub = vi.hoisted(() => ({ skill: null as unknown }));

vi.mock("../lib/hub-client.js", () => ({
  resolveHubConfig: async () => ({ podUrl: "https://pod.test", apiKey: "k" }),
  hubGet: async () => hub.skill,
}));

import { getSkill } from "./skills-commands.js";

const BODY = '---\npaths:\n  - "browser/**"\n---\n\nA rule line long enough that a terminal would wrap it, which --raw must never do.';

describe("synap skill get", () => {
  let out: string;
  let err: string;
  beforeEach(() => {
    out = "";
    err = "";
    vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => {
      out += String(s);
      return true;
    });
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      out += a.join(" ") + "\n";
    });
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      err += a.join(" ") + "\n";
    });
    process.exitCode = undefined;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  const skill = { slug: "rules/vocabulary", name: "rules/vocabulary", description: "d", body: BODY, topics: [], tags: [] };

  it("--raw prints the stored body exactly, ending in one newline", async () => {
    hub.skill = skill;
    await getSkill("rules/vocabulary", { raw: true });
    expect(out).toBe(BODY + "\n");
    expect(process.exitCode).toBeUndefined();
  });

  it("without --raw it still prints a heading around the body", async () => {
    hub.skill = skill;
    await getSkill("rules/vocabulary", {});
    expect(out).not.toBe(BODY + "\n");
    expect(out).toContain(BODY);
  });

  it("a missing skill exits 1 and writes nothing to stdout", async () => {
    hub.skill = null;
    await getSkill("rules/nope", { raw: true });
    expect(process.exitCode).toBe(1);
    expect(out).toBe("");
    expect(err).toContain("not found");
  });
});
