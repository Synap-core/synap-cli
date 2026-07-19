/**
 * Unit tests for the ONE project-ref resolution door (P4-lite W3).
 * All CP traffic is mocked via the injectable ResolveDeps seams — no network,
 * no ~/.synap reads (a token getter is always injected).
 */
import { describe, it, expect, vi } from "vitest";
import {
  parseProjectRef,
  resolveProjectRef,
  sessionScopeRefusal,
  samePodOrigin,
  candidateLabel,
  type CpProjectResolution,
} from "../src/lib/project-ref.js";

const UUID = "d4b84ad8-1111-2222-3333-444455556666";

const RESOLUTION: CpProjectResolution = {
  projectId: UUID,
  slug: "synap",
  name: "Synap",
  podId: "808939d1-86b3-4c52-a153-ae06ece2c54e",
  podUrl: "https://pod.perso.thearchitech.xyz",
  grant: "owner-relationship",
};

const token = () => ({ token: "cp-token" });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ─── parseProjectRef ──────────────────────────────────────────────────────────

describe("parseProjectRef", () => {
  it("recognizes a uuid (case-insensitive)", () => {
    expect(parseProjectRef(UUID)).toEqual({ kind: "uuid", id: UUID });
    expect(parseProjectRef(UUID.toUpperCase())).toEqual({ kind: "uuid", id: UUID });
  });

  it("recognizes the canonical <pod>/<slug> form", () => {
    expect(parseProjectRef("perso/synap")).toEqual({ kind: "fq", pod: "perso", slug: "synap" });
  });

  it("recognizes a bare slug", () => {
    expect(parseProjectRef("synap")).toEqual({ kind: "slug", slug: "synap" });
    expect(parseProjectRef("the-arch_2.0")).toEqual({ kind: "slug", slug: "the-arch_2.0" });
  });

  it("trims and lowercases", () => {
    expect(parseProjectRef("  Perso/Synap ")).toEqual({ kind: "fq", pod: "perso", slug: "synap" });
  });

  it("rejects malformed refs", () => {
    for (const bad of ["", "   ", "a/b/c", "sp ace", "/synap", "perso/", "-lead", "perso/-x"]) {
      expect(parseProjectRef(bad).kind, `ref: "${bad}"`).toBe("invalid");
    }
  });
});

// ─── resolveProjectRef ────────────────────────────────────────────────────────

describe("resolveProjectRef", () => {
  it("uuid short-circuits to local without touching the CP or the token", async () => {
    const fetchImpl = vi.fn();
    const getToken = vi.fn();
    const out = await resolveProjectRef(UUID, { fetchImpl, getToken });
    expect(out).toEqual({ kind: "local", projectId: UUID });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(getToken).not.toHaveBeenCalled();
  });

  it("returns invalid for malformed refs without touching the CP", async () => {
    const fetchImpl = vi.fn();
    const out = await resolveProjectRef("a/b/c", { fetchImpl, getToken: token });
    expect(out.kind).toBe("invalid");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns not-logged-in when no CP token is stored", async () => {
    const fetchImpl = vi.fn();
    const out = await resolveProjectRef("perso/synap", { fetchImpl, getToken: () => null });
    expect(out).toEqual({ kind: "not-logged-in" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("resolves a fq ref via the CP with bearer auth", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(RESOLUTION));
    const out = await resolveProjectRef("perso/synap", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getToken: token,
      cpUrl: "https://api.synap.live",
    });
    expect(out).toEqual({ kind: "resolved", project: RESOLUTION, refPod: "perso" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.synap.live/projects/resolve?ref=perso%2Fsynap");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer cp-token");
  });

  it("resolves a bare slug (no refPod hint)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(RESOLUTION));
    const out = await resolveProjectRef("synap", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getToken: token,
    });
    expect(out).toEqual({ kind: "resolved", project: RESOLUTION, refPod: undefined });
  });

  it("maps 300 to ambiguous with candidates (not an error crash)", async () => {
    const candidates = [
      { ...RESOLUTION, podSubdomain: "perso" },
      { ...RESOLUTION, podUrl: "https://pod.team.thearchitech.xyz", podSubdomain: "team" },
    ];
    const fetchImpl = vi.fn(async () => jsonResponse({ ambiguous: true, candidates }, 300));
    const out = await resolveProjectRef("synap", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getToken: token,
    });
    expect(out.kind).toBe("ambiguous");
    if (out.kind === "ambiguous") expect(out.candidates).toHaveLength(2);
  });

  it("maps 404 to not-found", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "Not found" }, 404));
    const out = await resolveProjectRef("perso/nope", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getToken: token,
    });
    expect(out).toEqual({ kind: "not-found", ref: "perso/nope" });
  });

  it("maps 401 to not-logged-in (stale token)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "unauthorized" }, 401));
    const out = await resolveProjectRef("synap", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getToken: token,
    });
    expect(out).toEqual({ kind: "not-logged-in" });
  });

  it("maps a network failure to cp-error (graceful, not a throw)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const out = await resolveProjectRef("synap", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getToken: token,
    });
    expect(out.kind).toBe("cp-error");
    if (out.kind === "cp-error") expect(out.message).toContain("could not reach");
  });

  it("maps a 5xx to cp-error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "boom" }, 500));
    const out = await resolveProjectRef("synap", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getToken: token,
    });
    expect(out).toEqual({ kind: "cp-error", message: "the project directory returned HTTP 500" });
  });

  it("maps an incomplete 200 body to cp-error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ slug: "synap" }));
    const out = await resolveProjectRef("synap", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getToken: token,
    });
    expect(out.kind).toBe("cp-error");
  });
});

// ─── session-scope guard ──────────────────────────────────────────────────────

describe("sessionScopeRefusal", () => {
  it("allows a project on the active pod (origin match, path-insensitive)", () => {
    expect(sessionScopeRefusal(RESOLUTION, "https://pod.perso.thearchitech.xyz")).toBeNull();
    expect(sessionScopeRefusal(RESOLUTION, "https://pod.perso.thearchitech.xyz/")).toBeNull();
  });

  it("refuses a cross-pod ref with a clear message", () => {
    const refusal = sessionScopeRefusal(RESOLUTION, "https://pod.team.thearchitech.xyz");
    expect(refusal).toContain("session lens has no pod field");
    expect(refusal).toContain(RESOLUTION.podUrl);
  });

  it("refuses when there is no active pod at all", () => {
    expect(sessionScopeRefusal(RESOLUTION, undefined)).toContain("session lens has no pod field");
  });
});

// ─── helpers ──────────────────────────────────────────────────────────────────

describe("helpers", () => {
  it("samePodOrigin compares origins only", () => {
    expect(samePodOrigin("https://a.example", "https://a.example/api/hub")).toBe(true);
    expect(samePodOrigin("https://a.example", "https://b.example")).toBe(false);
    expect(samePodOrigin(undefined, "https://a.example")).toBe(false);
  });

  it("candidateLabel derives the pod from podUrl, degrading gracefully", () => {
    expect(candidateLabel({ podUrl: "https://pod.team.thearchitech.xyz", slug: "synap" })).toBe(
      "pod.team.thearchitech.xyz/synap"
    );
    expect(candidateLabel({ slug: "synap" })).toBe("?/synap");
    expect(candidateLabel({ podUrl: "https://x.example", projectId: "p1", slug: null })).toBe(
      "x.example/p1"
    );
  });
});
