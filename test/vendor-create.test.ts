import { describe, it, expect } from "vitest";
import { createVendor, CpWriteError } from "../src/lib/cp-packages.js";

/**
 * `synap vendor create` must post the SAME contract the browser's
 * `PublishWizard` Publisher step posts — same endpoint, same field names — so
 * the two authoring doors cannot mint two different vendor shapes.
 *
 * Why the verb exists at all: the CP's publish handler is
 * `if (body.vendorId) { … }` with no else, and there is no back-fill. The CLI
 * could only ever READ a vendor (`fetchMyVendorId`), so a CLI-only author had no
 * way to create one and every package they published was attributed to nobody —
 * no `/superpowers/by/<slug>` page, permanently.
 *
 * These assert the REQUEST BODY, not merely that a helper ran. A prior test in
 * this repo (`publish-attaches-vendor`) recorded that covering the helper and
 * not the wire passed with the fix removed.
 */
const CREATED = (vendor: unknown) =>
  ({
    ok: true,
    status: 201,
    json: async () => ({ vendor }),
    text: async () => JSON.stringify({ vendor }),
  }) as unknown as Response;

const FAIL = (status: number, body: unknown) =>
  ({
    ok: false,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as Response;

const VENDOR = { id: "v-1", slug: "my-studio", displayName: "My Studio" };

/** Capture the single request `createVendor` makes. */
function recorder(res: Response) {
  const seen: { url?: string; init?: RequestInit } = {};
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.url = String(url);
    seen.init = init;
    return res;
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

describe("createVendor — the wire", () => {
  it("POSTs the wizard's contract to /api/vendors", async () => {
    const { seen, fetchImpl } = recorder(CREATED(VENDOR));
    const vendor = await createVendor(
      {
        slug: "my-studio",
        displayName: "My Studio",
        description: "We make things.",
        website: "https://example.com",
      },
      { fetchImpl, token: "tok", cpUrl: "https://cp.test" },
    );

    expect(seen.url).toBe("https://cp.test/api/vendors");
    expect(seen.init?.method).toBe("POST");
    expect(
      (seen.init?.headers as Record<string, string>).Authorization,
    ).toBe("Bearer tok");

    // The BODY is the contract — field names are the wizard's, verbatim.
    const body = JSON.parse(String(seen.init?.body));
    expect(body).toEqual({
      slug: "my-studio",
      displayName: "My Studio",
      description: "We make things.",
      website: "https://example.com",
    });
    expect(vendor).toEqual(VENDOR);
  });

  it("OMITS empty optionals instead of sending \"\" (the CP 400s on an empty website)", async () => {
    const { seen, fetchImpl } = recorder(CREATED(VENDOR));
    await createVendor(
      { slug: "my-studio", displayName: "My Studio", description: "", website: "" },
      { fetchImpl, token: "tok", cpUrl: "https://cp.test" },
    );
    const body = JSON.parse(String(seen.init?.body));
    expect(body).toEqual({ slug: "my-studio", displayName: "My Studio" });
    expect("website" in body).toBe(false);
    expect("description" in body).toBe(false);
  });

  it("surfaces the CP's own 409 message (already have one / slug taken)", async () => {
    const { fetchImpl } = recorder(
      FAIL(409, { error: "You already have a vendor profile" }),
    );
    await expect(
      createVendor(
        { slug: "my-studio", displayName: "My Studio" },
        { fetchImpl, token: "tok", cpUrl: "https://cp.test" },
      ),
    ).rejects.toMatchObject({
      status: 409,
      serverMessage: "You already have a vendor profile",
    });
  });

  it("refuses without a session rather than posting anonymously", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return CREATED(VENDOR);
    }) as unknown as typeof fetch;
    await expect(
      createVendor(
        { slug: "my-studio", displayName: "My Studio" },
        { fetchImpl, token: "", cpUrl: "https://cp.test" },
      ),
    ).rejects.toBeInstanceOf(CpWriteError);
    expect(called, "no request may be made without a token").toBe(false);
  });
});
