import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The PROVISIONING_TOKEN is a pod-side BOOTSTRAP secret (SECURITY-PLAN-R1 §4,
 * D9): the pod accepts it only until it has an owner, and the installer drops
 * it from `.env` at that moment. The CLI must therefore never take one — an
 * agent key is minted with a person's key or a device-flow approval
 * (`provisionAgentKey`), never with this token. The last such door
 * (an add-on enable call taking the token) is gone.
 *
 * The scanned set is DERIVED: every .ts under src/. A CODE line (not a `//` or
 * block-comment line) naming `provisioningToken` or `PROVISIONING_TOKEN` is a hit.
 *
 * What it does NOT see: the token reached under another name, or built from
 * a string (`"PROVISIONING_" + "TOKEN"`); granularity is the line.
 */
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.tsx?$/.test(name) && !name.endsWith(".d.ts") ? [full] : [];
  });
}

const TOKEN = /provisioningToken|PROVISIONING_TOKEN/;
const isComment = (line: string) => /^\s*(\/\/|\/\*|\*)/.test(line);

export function hits(src: string): string[] {
  return src
    .split("\n")
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => !isComment(line) && TOKEN.test(line))
    .map(({ line, n }) => `${n}: ${line.trim()}`);
}

describe("the CLI has no PROVISIONING_TOKEN door", () => {
  const files = sources(SRC);

  it("is non-vacuous: sees real code and still recognises the shapes it hunts", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(hits("export async function f(provisioningToken: string) {}")).toHaveLength(1);
    expect(hits("const t = process.env.PROVISIONING_TOKEN;")).toHaveLength(1);
    expect(hits(" * Uses the PROVISIONING_TOKEN directly against the pod.")).toHaveLength(0);
    expect(hits("// PROVISIONING_TOKEN is bootstrap-only")).toHaveLength(0);
  });

  it("no source file takes or reads a provisioning token", () => {
    const offenders = files
      .map((f) => ({ f: relative(SRC, f), h: hits(readFileSync(f, "utf8")) }))
      .filter((r) => r.h.length > 0)
      .map((r) => `${r.f}\n  ${r.h.join("\n  ")}`);
    expect(offenders).toEqual([]);
  });
});
