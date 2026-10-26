/**
 * `synap doctor` names who holds the key and on which computer (D1/D2), from
 * the pod's `GET /users/me` `principal` — shapes copied from synap-backend
 * `routers/hub-protocol/rest/users.ts`. An older pod (no `principal`) prints
 * no line rather than a guess.
 */
import { describe, it, expect } from "vitest";
import { keyHolderCheck } from "../src/commands/doctor.js";

const me = (principal: unknown) => ({ id: "human-1", scopes: [], isAgent: true, principal });

describe("keyHolderCheck", () => {
  it("an AI on a computer: '<AI> on <computer>'", () => {
    const c = keyHolderCheck(
      me({ id: "a1", kind: "agent", name: "Claude Code", hostUserId: "m1", hostName: "devbox" })
    );
    expect(c).toMatchObject({ name: "Key holder", ok: true, detail: "Claude Code on devbox" });
  });

  it("an AI on no computer says so, and how to bind it", () => {
    const c = keyHolderCheck(me({ id: "a2", kind: "agent", name: "Codex", hostUserId: null, hostName: null }));
    expect(c!.detail).toContain("Codex, on no computer");
    expect(c!.detail).toContain("synap init");
  });

  it("a computer's key, a person's key", () => {
    expect(
      keyHolderCheck(me({ id: "m1", kind: "machine", name: "devbox", hostUserId: "m1", hostName: "devbox" }))!.detail
    ).toBe("this computer's key (devbox)");
    expect(keyHolderCheck(me({ id: "h1", kind: "human", name: "Ada", hostUserId: null, hostName: null }))!.detail).toBe(
      "a person's own key (Ada)"
    );
  });

  it("an older pod (no principal) prints nothing", () => {
    expect(keyHolderCheck({ id: "human-1", scopes: [], isAgent: true })).toBeNull();
    expect(keyHolderCheck(me(null))).toBeNull();
  });
});
