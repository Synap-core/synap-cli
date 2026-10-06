import { describe, expect, it } from "vitest";
import { buildApproveRequestBody } from "../src/commands/proposals-actions.js";

const ID = "3f2b8c1e-7a4d-4e9b-9c21-5d8f0a6b1e73";

describe("buildApproveRequestBody", () => {
  it("is { reason } only when no choice was passed", () => {
    expect(buildApproveRequestBody({ reason: "looks right" })).toEqual({
      ok: true,
      body: { reason: "looks right" },
    });
    expect(buildApproveRequestBody({})).toEqual({
      ok: true,
      body: { reason: undefined },
    });
  });

  it("sends identityResolution whole, and separate does not require an existing id", () => {
    expect(buildApproveRequestBody({ verb: "separate", reason: "new" })).toEqual({
      ok: true,
      body: {
        reason: "new",
        identityResolution: { verb: "separate" },
      },
    });
    expect(buildApproveRequestBody({ verb: "keep_existing", existing: ID })).toEqual({
      ok: true,
      body: {
        reason: undefined,
        identityResolution: { verb: "keep_existing", existingEntityId: ID },
      },
    });
  });

  it("refuses fill_empty, keep_existing, and use_capture without --existing", () => {
    for (const verb of ["fill_empty", "keep_existing", "use_capture"] as const) {
      const built = buildApproveRequestBody({ verb });
      expect(built.ok).toBe(false);
      if (!built.ok) expect(built.message).toContain("--existing");
    }
  });

  it("refuses --existing without a verb, an unknown verb, and a non-uuid", () => {
    expect(buildApproveRequestBody({ existing: ID }).ok).toBe(false);
    expect(buildApproveRequestBody({ verb: "merge", existing: ID }).ok).toBe(false);
    expect(buildApproveRequestBody({ verb: "separate", existing: "ada" }).ok).toBe(false);
  });
});
