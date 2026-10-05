/**
 * `synap upload` — lane choice, field pass-through, and the --workspace pin.
 *
 * Drives the real `sendUpload` with the Hub client and `fetch` stubbed, and
 * asserts on what reaches the wire.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  hubPost: vi.fn(),
  hubPostMultipart: vi.fn(),
}));
vi.mock("../src/lib/hub-client.js", () => ({
  resolveHubConfig: vi.fn(),
  resolveUserId: vi.fn(),
  hubPost: h.hubPost,
  hubPostMultipart: h.hubPostMultipart,
  renderHubError: vi.fn(),
}));

import {
  sendUpload,
  parseProps,
  maxUploadBytesForMime,
  mimeFor,
} from "../src/commands/upload.js";

const MB = 1024 * 1024;
const cfg = { podUrl: "https://pod.example", apiKey: "k" } as never;
const WS = "11111111-1111-4111-8111-111111111111";

const fetchMock = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  h.hubPostMultipart.mockResolvedValue({ fileEntityId: "e", documentId: "d" });
});
afterEach(() => vi.unstubAllGlobals());

const buf = (n: number) => Buffer.alloc(n) as Buffer<ArrayBuffer>;

describe("small files → multipart /files", () => {
  it("passes profile, properties and an explicit workspace pin", async () => {
    await sendUpload(
      {
        buf: buf(10),
        filename: "logo.svg",
        mimeType: "image/svg+xml",
        workspaceId: WS,
        targetWorkspaceId: WS,
        profileSlug: "brand-asset",
        properties: { variant: "dark" },
      },
      cfg
    );
    expect(h.hubPostMultipart).toHaveBeenCalledOnce();
    const [path, form] = h.hubPostMultipart.mock.calls[0]!;
    expect(path).toBe("/files");
    expect(form.get("workspaceId")).toBe(WS);
    expect(form.get("targetWorkspaceId")).toBe(WS);
    expect(form.get("profileSlug")).toBe("brand-asset");
    expect(JSON.parse(form.get("properties"))).toEqual({ variant: "dark" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("without --workspace the configured workspace is context only (no pin)", async () => {
    await sendUpload(
      { buf: buf(10), filename: "a.pdf", mimeType: "application/pdf", workspaceId: WS, properties: {} },
      cfg
    );
    const form = h.hubPostMultipart.mock.calls[0]![1];
    expect(form.get("workspaceId")).toBe(WS);
    expect(form.get("targetWorkspaceId")).toBeNull();
    expect(form.get("properties")).toBeNull();
  });
});

describe("large files → presigned lane", () => {
  it("requests a ticket, PUTs straight to storage, then finalizes", async () => {
    h.hubPost
      .mockResolvedValueOnce({
        uploadUrl: "https://pod.example/synap-storage/k?sig",
        uploadToken: "tok",
        headers: { "Content-Type": "video/mp4" },
      })
      .mockResolvedValueOnce({ fileEntityId: "e2", documentId: "d2" });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

    const res = await sendUpload(
      {
        buf: buf(11 * MB),
        filename: "launch.mp4",
        mimeType: "video/mp4",
        workspaceId: WS,
        targetWorkspaceId: WS,
        title: "Launch",
        profileSlug: "brand-asset",
        properties: { usage: "hero" },
      },
      cfg
    );

    expect(res).toEqual({ fileEntityId: "e2", documentId: "d2" });
    expect(h.hubPostMultipart).not.toHaveBeenCalled();
    expect(h.hubPost.mock.calls[0]![0]).toBe("/files/uploads");
    expect(h.hubPost.mock.calls[0]![1]).toEqual({
      workspaceId: WS,
      targetWorkspaceId: WS,
      filename: "launch.mp4",
      mimeType: "video/mp4",
      size: 11 * MB,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://pod.example/synap-storage/k?sig");
    expect(init.method).toBe("PUT");
    expect(init.headers["Content-Type"]).toBe("video/mp4");
    expect(h.hubPost.mock.calls[1]![0]).toBe("/files/uploads/finalize");
    expect(h.hubPost.mock.calls[1]![1]).toEqual({
      uploadToken: "tok",
      title: "Launch",
      profileSlug: "brand-asset",
      properties: { usage: "hero" },
      targetWorkspaceId: WS,
    });
  });

  it("a failed PUT is an error, never a finalize", async () => {
    h.hubPost.mockResolvedValueOnce({ uploadUrl: "u", uploadToken: "tok" });
    fetchMock.mockResolvedValueOnce(new Response("SignatureDoesNotMatch", { status: 403 }));
    await expect(
      sendUpload(
        { buf: buf(11 * MB), filename: "a.mp4", mimeType: "video/mp4", workspaceId: WS, properties: {} },
        cfg
      )
    ).rejects.toThrow(/HTTP 403/);
    expect(h.hubPost).toHaveBeenCalledTimes(1);
  });
});

describe("helpers", () => {
  it("parseProps collects key=value (value may contain =) and rejects junk", () => {
    expect(parseProps(["a=1", "b=x=y"])).toEqual({ a: "1", b: "x=y" });
    expect(() => parseProps(["nope"])).toThrow();
  });
  it("mirrors the pod's caps and knows font types", () => {
    expect(maxUploadBytesForMime("video/mp4")).toBe(500 * MB);
    expect(maxUploadBytesForMime("font/woff2")).toBe(5 * MB);
    expect(maxUploadBytesForMime("image/png")).toBe(10 * MB);
    expect(mimeFor("brand.woff2")).toBe("font/woff2");
  });
});
