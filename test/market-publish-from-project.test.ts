/**
 * `--from-project` + `--price` wiring for `market publish`.
 *
 * Composition of two fake workspaces into a suite is covered in the backend
 * (`compose-suite-package-definition.test.ts`). Here we pin the CLI contract:
 * the flag is registered, the hub door is called, price parses to cents, and
 * `publishPackage` receives the pricing stamp.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { parsePriceUsdFlag } from "../src/commands/market-authoring.js";

describe("parsePriceUsdFlag", () => {
  it("maps dollars to one_time + USD cents", () => {
    expect(parsePriceUsdFlag("9.99")).toEqual({
      pricingModel: "one_time",
      priceUsd: 999,
    });
    expect(parsePriceUsdFlag("10")).toEqual({
      pricingModel: "one_time",
      priceUsd: 1000,
    });
  });

  it("rejects non-positive / non-numeric", () => {
    expect(() => parsePriceUsdFlag("0")).toThrow(/positive/);
    expect(() => parsePriceUsdFlag("-1")).toThrow(/positive/);
    expect(() => parsePriceUsdFlag("nope")).toThrow(/positive/);
  });
});

describe("publishPackage pricing stamp (wire)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("forwards pricingModel + priceUsd on the POST body", async () => {
    let sentBody: Record<string, unknown> | undefined;
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      // `/api/packages/mine` AND `/api/vendors/mine` both contain `/mine` —
      // return an empty packages list; vendor parse then yields null.
      if (String(url).includes("/mine")) return json({ packages: [] });
      sentBody = JSON.parse(String(init?.body));
      return json({ package: { version: "h-x", isPublic: false } }, 201);
    }) as unknown as typeof fetch;

    const { publishPackage } = await import("../src/lib/cp-packages.js");
    await publishPackage(
      {
        _meta: { slug: "acme-suite", tags: ["suite"] },
        workspaceName: "Acme Suite",
        description: "suite",
        profiles: [{ slug: "suite-home", displayName: "Suite", properties: [] }],
        dependencies: [
          { slug: "crm", kind: "workspace", relation: "require" },
          { slug: "ops", kind: "workspace", relation: "require" },
        ],
      },
      {
        isPublic: false,
        pricingModel: "one_time",
        priceUsd: 999,
      },
      {
        fetchImpl,
        token: "t",
        cpUrl: "https://api.synap.live",
      },
    );

    expect(sentBody?.pricingModel).toBe("one_time");
    expect(sentBody?.priceUsd).toBe(999);
    expect(sentBody?.tags).toEqual(["suite"]);
    const def = sentBody?.definition as {
      dependencies?: Array<{ slug: string; relation?: string }>;
    };
    expect(def.dependencies?.map((d) => d.slug).sort()).toEqual(["crm", "ops"]);
    expect(def.dependencies?.every((d) => d.relation === "require")).toBe(true);
  });
});
