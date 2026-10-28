/**
 * F11 — `synap init` → "Self-host" prints an installer that exists.
 *
 * The defect: it printed `curl -fsSL https://synap.live/install.sh | bash`,
 * which 404s (checked live 2026-10-28) and runs without the root the
 * installer needs; a dead helper and the README piped
 * `raw.githubusercontent.com/…/main/install.sh` (an unreleased branch head)
 * into bash. The installer is the backend's `channel-stable` release asset
 * (synap-backend/deploy/README.md).
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { SELF_HOST_INSTALL_URL, selfHostInstallCommands } from "../src/lib/self-host.js";

const ROOT = path.resolve(__dirname, "..");

function walk(d: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("self-host installer hint", () => {
  it("names the released installer, run as root after it is read", () => {
    expect(SELF_HOST_INSTALL_URL).toBe(
      "https://github.com/synap-core/backend/releases/download/channel-stable/install.sh"
    );
    const lines = selfHostInstallCommands();
    expect(lines[0]).toContain(SELF_HOST_INSTALL_URL);
    expect(lines.join("\n")).not.toMatch(/\|\s*(sudo\s+)?bash/); // downloaded to a file, never piped
    expect(lines.some((l) => l.startsWith("sudo bash "))).toBe(true);
  });

  it("`synap init` prints it through the one helper", () => {
    const init = fs.readFileSync(path.join(ROOT, "src/commands/init.ts"), "utf8");
    expect(init).toMatch(/selfHostInstallCommands\(\)/);
  });

  it("no source file or README names a dead or unreleased installer", () => {
    const files = [...walk(path.join(ROOT, "src")), path.join(ROOT, "README.md")];
    expect(files.length).toBeGreaterThan(60); // non-vacuity
    const offenders = files.filter((f) => {
      const t = fs.readFileSync(f, "utf8");
      return /synap\.live\/install\.sh/.test(t) || /raw\.githubusercontent\.com\/[^\s'"`]*\/main\/install\.sh/.test(t);
    });
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });
});
