/**
 * Unit tests for the CP publish transport (`lib/cp-packages`): reserved-slug 403
 * surfacing, created vs no-op detection. All CP traffic is mocked via the
 * injected `fetchImpl`/`token`/`cpUrl` seams — no network, no `~/.synap`.
 */
import { describe, it, expect, vi } from "vitest";
import {
  publishPackage,
  unpublishPackage,
  CpWriteError,
  type PublishResult,
} from "../src/lib/cp-packages.js";
import type { PackageDefinitionLike } from "../src/lib/template-file.js";

const DEF: PackageDefinitionLike = {
  _meta: { slug: "my-space", icon: "📦", tags: ["demo"] },
  workspaceName: "My Space",
  description: "A demo workspace.",
  profiles: [{ slug: "thing", displayName: "Thing", properties: [] }],
};

const deps = (fetchImpl: typeof fetch) => ({
  fetchImpl,
  token: "cp-token",
  cpUrl: "https://api.synap.live",
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A fetch double: `/mine` GET → `mineRows`, POST/PATCH → `write`. */
function cpDouble(mineRows: unknown[], write: () => Response) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes("/api/packages/mine")) {
      return json({ packages: mineRows });
    }
    return write();
  }) as unknown as typeof fetch;
}

describe("publishPackage", () => {
  it("surfaces a 403 reserved-slug rejection with the server message (not swallowed)", async () => {
    const fetchImpl = cpDouble([], () =>
      json(
        { error: '"foundation" is a reserved bedrock package slug and can only be published by the official Synap vendor' },
        403,
      ),
    );
    await expect(
      publishPackage({ ...DEF, _meta: { slug: "foundation" } }, { isPublic: true }, deps(fetchImpl)),
    ).rejects.toMatchObject({ status: 403 });

    try {
      await publishPackage({ ...DEF, _meta: { slug: "foundation" } }, { isPublic: true }, deps(fetchImpl));
    } catch (e) {
      expect(e).toBeInstanceOf(CpWriteError);
      expect((e as CpWriteError).serverMessage).toMatch(/reserved/i);
    }
  });

  it("reports 'created' on a 201 (slug the account never had)", async () => {
    const fetchImpl = cpDouble([], () => json({ package: { version: "h-aaa", isPublic: false } }, 201));
    const r: PublishResult = await publishPackage(DEF, { isPublic: false }, deps(fetchImpl));
    expect(r.outcome).toBe("created");
    expect(r.version).toBe("h-aaa");
    expect(r.isPublic).toBe(false);
  });

  it("reports 'no-op' when the caller's row already carries the returned version", async () => {
    const fetchImpl = cpDouble(
      [{ slug: "my-space", displayName: "My Space", version: "h-same" }],
      () => json({ package: { version: "h-same", isPublic: true } }, 200),
    );
    const r = await publishPackage(DEF, { isPublic: true }, deps(fetchImpl));
    expect(r.outcome).toBe("no-op");
  });

  it("reports 'updated' when the returned version differs from the prior one", async () => {
    const fetchImpl = cpDouble(
      [{ slug: "my-space", displayName: "My Space", version: "h-old" }],
      () => json({ package: { version: "h-new", isPublic: true } }, 200),
    );
    const r = await publishPackage(DEF, { isPublic: true }, deps(fetchImpl));
    expect(r.outcome).toBe("updated");
  });

  it("hoists _meta.icon onto definition.icon and sends the expected POST body", async () => {
    let sentBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/mine")) return json({ packages: [] });
      sentBody = JSON.parse(String(init?.body));
      return json({ package: { version: "h-x", isPublic: false } }, 201);
    }) as unknown as typeof fetch;
    await publishPackage(DEF, { isPublic: false }, deps(fetchImpl));
    expect(sentBody?.slug).toBe("my-space");
    expect(sentBody?.displayName).toBe("My Space");
    expect(sentBody?.category).toBe("workspace");
    expect((sentBody?.definition as { icon?: string }).icon).toBe("📦");
  });

  it("refuses a definition with no slug", async () => {
    const fetchImpl = cpDouble([], () => json({}, 201));
    await expect(
      publishPackage({ ...DEF, _meta: {} }, { isPublic: false }, deps(fetchImpl)),
    ).rejects.toBeInstanceOf(CpWriteError);
  });
});

describe("unpublishPackage", () => {
  it("PATCHes the slug and surfaces a CP validation failure honestly", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ error: "Invalid request", detail: "podId is required" }, 400),
    ) as unknown as typeof fetch;
    try {
      await unpublishPackage("my-space", { fetchImpl, token: "t", cpUrl: "https://api.synap.live" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CpWriteError);
      expect((e as CpWriteError).status).toBe(400);
      expect((e as CpWriteError).serverMessage).toContain("podId is required");
    }
  });

  it("returns the new visibility on success", async () => {
    const fetchImpl = vi.fn(async () => json({ slug: "my-space", isPublic: false })) as unknown as typeof fetch;
    const r = await unpublishPackage("my-space", { fetchImpl, token: "t", cpUrl: "https://api.synap.live" });
    expect(r).toEqual({ slug: "my-space", isPublic: false });
  });
});
