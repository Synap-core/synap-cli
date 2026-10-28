/**
 * F8 — `synap raycast generate` never writes pod-supplied text as shell code.
 *
 * Verb ids, labels and parameter names come from capability metadata (any
 * marketplace vendor's), and the script is executable. The defect wrote them
 * unquoted: a verb id `x; touch …`, a label with a newline, or a parameter
 * key `a" ; touch … ; "` ran its command when the person launched it.
 *
 * Each script is EXECUTED with a fake `synap` on PATH that records its argv,
 * so the test reads what bash really ran, not the shape of the text.
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { renderScript, type RunnableVerb } from "../src/commands/raycast.js";

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** Run a rendered script with `args`; return the argv the fake `synap` got and whether PROOF appeared. */
function run(content: string, args: string[]): { argv: string[]; injected: boolean } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synap-rc-"));
  made.push(dir);
  const proof = path.join(dir, "INJECTED");
  const argvFile = path.join(dir, "argv");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "synap"), `#!/bin/bash\nprintf '%s\\n' "$@" > ${JSON.stringify(argvFile)}\n`, { mode: 0o755 });
  const script = path.join(dir, "cmd.sh");
  fs.writeFileSync(script, content, { mode: 0o755 });
  execFileSync("bash", [script, ...args], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PROOF: proof },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const argv = fs.existsSync(argvFile) ? fs.readFileSync(argvFile, "utf8").split("\n").slice(0, -1) : [];
  return { argv, injected: fs.existsSync(proof) };
}

const verb = (v: Partial<RunnableVerb>): RunnableVerb => ({
  toolName: "Mail", verbId: "mail.send", label: "Send", params: ["to", "subject"], ...v,
});

describe("raycast script rendering", () => {
  it("a plain verb runs exactly `synap capability run <id> --<p> <value>…`", () => {
    const r = renderScript(verb({}));
    if ("refused" in r) throw new Error(r.refused);
    const { argv, injected } = run(r.content, ["a@b.c", "hi $(touch $PROOF)"]);
    expect(argv).toEqual(["capability", "run", "mail.send", "--to", "a@b.c", "--subject", "hi $(touch $PROOF)"]);
    expect(injected).toBe(false);
  });

  it("a label or tool name with a newline stays inside the comment", () => {
    const r = renderScript(verb({ toolName: "T\ntouch $PROOF", label: "L\r\ntouch $PROOF x" }));
    if ("refused" in r) throw new Error(r.refused);
    const { argv, injected } = run(r.content, ["x", "y"]);
    expect(injected).toBe(false);
    expect(argv.slice(0, 3)).toEqual(["capability", "run", "mail.send"]);
    expect(r.content.split("\n").filter((l) => l && !l.startsWith("#"))).toHaveLength(1); // only the exec line
  });

  it.each([
    ["verb id with a command", { verbId: "x; touch $PROOF #" }],
    ["verb id with a substitution", { verbId: "x$(touch $PROOF)" }],
    ["verb id read as an option", { verbId: "--help" }],
    ["parameter with quotes", { params: ['a" ; touch $PROOF ; "'] }],
    ["parameter with a space", { params: ["a b"] }],
  ])("refuses a %s", (_name, v) => {
    const r = renderScript(verb(v));
    expect("refused" in r).toBe(true);
  });

  it("no params falls back to one `input` argument", () => {
    const r = renderScript(verb({ params: [] }));
    if ("refused" in r) throw new Error(r.refused);
    expect(r.usedFallback).toBe(true);
    expect(run(r.content, ["free text"]).argv).toEqual(["capability", "run", "mail.send", "--input", "free text"]);
  });
});
