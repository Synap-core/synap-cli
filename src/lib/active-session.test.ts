/**
 * Which focus session a CLI call carries, and what `synap session detach`
 * clears: env, the bridge's binding, the session lens, the directory lens —
 * and how a 4xx refusal reads at the terminal.
 */
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const home = vi.hoisted(() => {
  // os.homedir() reads HOME; the lens dirs are derived from it at import.
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const h = mkdtempSync(`${tmpdir()}/synap-active-session-`);
  process.env.HOME = h;
  return h;
});

import {
  attachActiveSessionId,
  detachActiveSessionId,
  HubError,
  renderHubError,
  resolveActiveSessionId,
} from "./hub-client.js";
import { writeDirectoryLens, findDirectoryLens } from "./directory-lens.js";

const DIR_SESSION = "dddddddd-0000-4000-8000-000000000001";
const BRIDGE_SESSION = "bbbbbbbb-0000-4000-8000-000000000002";
const ENV_SESSION = "eeeeeeee-0000-4000-8000-000000000003";
const TAB_SESSION = "cccccccc-0000-4000-8000-000000000004";

let proj: string;
const cwd0 = process.cwd();

beforeEach(() => {
  proj = mkdtempSync(join(home, "proj-"));
  process.chdir(proj);
  for (const k of ["SYNAP_SESSION_ID", "SYNAP_POD_SESSION", "SYNAP_LENS_SESSION", "CLAUDE_CODE_SESSION_ID"]) {
    vi.stubEnv(k, "");
  }
  writeDirectoryLens({ focusSessionId: DIR_SESSION });
});

afterEach(() => {
  process.chdir(cwd0);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("resolveActiveSessionId", () => {
  it("inside a bridge-bound conversation, SYNAP_POD_SESSION is the session", () => {
    vi.stubEnv("CLAUDE_CODE_SESSION_ID", "conv-1");
    vi.stubEnv("SYNAP_POD_SESSION", BRIDGE_SESSION);
    expect(resolveActiveSessionId()).toBe(BRIDGE_SESSION);
  });

  it("SYNAP_SESSION_ID (explicit) outranks the bridge's binding", () => {
    vi.stubEnv("SYNAP_SESSION_ID", ENV_SESSION);
    vi.stubEnv("SYNAP_POD_SESSION", BRIDGE_SESSION);
    expect(resolveActiveSessionId()).toBe(ENV_SESSION);
  });

  it("inside a conversation with no binding, the directory lens supplies nothing", () => {
    vi.stubEnv("CLAUDE_CODE_SESSION_ID", "conv-1");
    expect(resolveActiveSessionId()).toBeUndefined();
  });

  it("outside a conversation the directory lens still supplies the session", () => {
    expect(resolveActiveSessionId()).toBe(DIR_SESSION);
  });
});

describe("detachActiveSessionId", () => {
  it("inside a conversation it clears the session lens only, and reports that session", () => {
    vi.stubEnv("CLAUDE_CODE_SESSION_ID", "conv-1");
    expect(attachActiveSessionId(TAB_SESSION)).toBe("session-lens");
    expect(detachActiveSessionId()).toBe(TAB_SESSION);
    // The plain terminal's session in this tree is untouched...
    expect(findDirectoryLens()?.lens.focusSessionId).toBe(DIR_SESSION);
    // ...and `previous` was never the directory's session.
    expect(detachActiveSessionId()).toBeUndefined();
  });

  it("outside a conversation it clears the directory lens", () => {
    expect(detachActiveSessionId()).toBe(DIR_SESSION);
    expect(findDirectoryLens()?.lens.focusSessionId).toBeUndefined();
  });
});

describe("renderHubError: a 4xx refusal leads with the pod's words", () => {
  const refusal = (status: number, body: unknown) =>
    new HubError({
      message: `Hub POST /focus-sessions failed (HTTP ${status}): ${(body as { message: string }).message}`,
      status,
      detail: (body as { message: string }).message,
      body,
      rawBody: JSON.stringify(body),
      path: "/focus-sessions",
      method: "POST",
    });

  const printed = (err: HubError): string => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    renderHubError(err);
    return spy.mock.calls.map((c) => c.join(" ")).join("\n");
  };

  it("a 400 prints the pod's message without the Hub-call prefix", () => {
    const out = printed(refusal(400, { message: "templateId must be a playbook id, or null" }));
    expect(out).toContain("templateId must be a playbook id, or null");
    expect(out).not.toContain("failed (HTTP 400)");
    expect(out).not.toContain("Hub POST");
  });

  it("a 404 keeps the full line (its hints read the path)", () => {
    expect(printed(refusal(404, { message: "not found" }))).toContain("Hub POST /focus-sessions failed (HTTP 404)");
  });
});
