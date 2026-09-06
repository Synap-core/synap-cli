import { describe, it, expect } from "vitest";
import { fetchMyVendorId, publishPackage } from "../src/lib/cp-packages.js";

/**
 * A published package must be attributed to its author's publisher profile.
 *
 * The CP's publish handler is `if (body.vendorId) { … }` with **no else**
 * (`synap-control-plane-api/src/routes/packages.ts:1465`) — it never
 * auto-creates a vendor and never infers one from the session. The CLI had
 * never sent the field (`rg "vendor" synap-cli/src` → zero hits), so every
 * CLI-published package was permanently ORPHANED: it can never appear on
 * `GET /api/vendors/:slug`, the ready-made public publisher profile.
 *
 * Not cosmetic — vendor identity is already load-bearing elsewhere (reserved
 * bedrock slugs gate on `isOfficialVendor`).
 *
 * The lookup is BEST-EFFORT on purpose: a first-time publisher has no vendor
 * yet, and publishing must not fail because of that. So the contract under test
 * is "resolve it when it exists, return null and stay quiet when it doesn't" —
 * never throw, never block.
 */
const OK = (body: unknown) =>
  ({ ok: true, json: async () => body }) as unknown as Response;
const NOT_OK = (status: number) =>
  ({ ok: false, status, json: async () => ({}) }) as unknown as Response;

describe("fetchMyVendorId", () => {
  it("returns the vendor id when the author has a publisher profile", async () => {
    const calls: string[] = [];
    const id = await fetchMyVendorId("https://cp.test", "tok", (async (url: string) => {
      calls.push(String(url));
      return OK({ vendor: { id: "vendor-123", slug: "antoine" } });
    }) as unknown as typeof fetch);
    expect(id).toBe("vendor-123");
    // Must use the EXISTING authed door, not a new endpoint.
    expect(calls[0]).toBe("https://cp.test/api/vendors/mine");
  });

  it("returns null — not a throw — for a first-time publisher with no vendor", async () => {
    const id = await fetchMyVendorId("https://cp.test", "tok", (async () =>
      OK({ vendor: null })) as unknown as typeof fetch);
    expect(id).toBeNull();
  });

  it("never blocks a publish when the lookup fails", async () => {
    const onHttpError = await fetchMyVendorId("https://cp.test", "tok", (async () =>
      NOT_OK(500)) as unknown as typeof fetch);
    expect(onHttpError).toBeNull();

    const onNetworkError = await fetchMyVendorId("https://cp.test", "tok", (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch);
    expect(onNetworkError).toBeNull();
  });
});

/**
 * The lookup tests above are NOT enough on their own: removing the field from
 * the request body leaves every one of them green. This is the assertion that
 * actually pins the wire — verified by mutation.
 */
describe("publishPackage sends vendorId on the wire", () => {
  function harness(vendor: unknown) {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/api/vendors/mine")) return OK({ vendor });
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return OK({ package: { slug: "s", version: "v" } });
    }) as unknown as typeof fetch;
    return { bodies, fetchImpl };
  }

  it("includes vendorId when the author has a publisher profile", async () => {
    const { bodies, fetchImpl } = harness({ id: "vendor-123" });
    await publishPackage(
      { _meta: { slug: "probe" }, workspaceName: "Probe" } as never,
      { isPublic: false, category: "cell" },
      { fetchImpl, token: "tok", cpUrl: "https://cp.test" } as never,
    );
    const publishBody = bodies.at(-1)!;
    expect(
      publishBody.vendorId,
      "the publish body carries no vendorId — the CP's `if (body.vendorId)` has no " +
        "else, so the package is orphaned from its publisher profile forever."
    ).toBe("vendor-123");
  });

  it("OMITS the key entirely (not null) when there is no vendor", async () => {
    const { bodies, fetchImpl } = harness(null);
    await publishPackage(
      { _meta: { slug: "probe" }, workspaceName: "Probe" } as never,
      { isPublic: false, category: "cell" },
      { fetchImpl, token: "tok", cpUrl: "https://cp.test" } as never,
    );
    // The CP branches on PRESENCE; sending an explicit null would be a different
    // statement than saying nothing.
    expect(Object.hasOwn(bodies.at(-1)!, "vendorId")).toBe(false);
  });
});
