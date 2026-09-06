import { describe, it, expect } from "vitest";
import {
  buildKeepRawPayload,
  keepRawLine,
} from "../src/commands/import.js";

/**
 * Dogfooding a real PDF import found the entities created correctly and the
 * ORIGINAL discarded: no `documentId`, no `sourceFile*` properties, and no
 * `--keep-raw` in `synap import --help` (only `--with-audio`, which is
 * Superwhisper-specific). These tests pin the payload that fixes it.
 */

const pdfItem = {
  kind: "file" as const,
  label: "invoice.pdf",
  path: "invoice.pdf",
  file: {
    content: "JVBERi0x",
    mimeType: "application/pdf",
    filename: "invoice.pdf",
    encoding: "base64" as const,
  },
};

const mdItem = {
  kind: "file" as const,
  label: "note.md",
  path: "note.md",
  file: {
    content: "# hello",
    mimeType: "text/markdown",
    filename: "note.md",
    encoding: "utf8" as const,
  },
};

const urlItem = { kind: "url" as const, label: "example.com", url: "https://example.com" };

describe("buildKeepRawPayload", () => {
  it("sends nothing at all without --keep-raw (default stays extract-and-discard)", () => {
    expect(buildKeepRawPayload({}, pdfItem, {})).toEqual({});
    expect(buildKeepRawPayload({ keepRaw: false }, pdfItem, {})).toEqual({});
  });

  it("threads keepRaw + the bytes for a binary file", () => {
    expect(buildKeepRawPayload({ keepRaw: true }, pdfItem, {})).toEqual({
      keepRaw: true,
      file: {
        content: "JVBERi0x",
        mimeType: "application/pdf",
        filename: "invoice.pdf",
      },
    });
  });

  it("base64-encodes a utf8-read text file", () => {
    // `fileToItem` reads text-like files as utf8, but the pod does
    // `Buffer.from(content, "base64")` unconditionally. Sending utf8 there
    // stores a mangled blob and reports no error at all.
    const payload = buildKeepRawPayload({ keepRaw: true }, mdItem, {}) as {
      file: { content: string };
    };
    expect(payload.file.content).toBe(
      Buffer.from("# hello", "utf8").toString("base64")
    );
    expect(Buffer.from(payload.file.content, "base64").toString("utf8")).toBe(
      "# hello"
    );
  });

  it("echoes the extracted text so the stored document has a real body", () => {
    const payload = buildKeepRawPayload({ keepRaw: true }, pdfItem, {
      extraction: {
        kind: "pdf",
        extractor: "pdf-parse",
        text: "Invoice #42",
        textTruncated: true,
      },
    });
    expect(payload).toEqual({
      keepRaw: true,
      file: {
        content: "JVBERi0x",
        mimeType: "application/pdf",
        filename: "invoice.pdf",
        extractedText: "Invoice #42",
        extractedTextTruncated: true,
      },
    });
  });

  it("omits extractedText when the pod sent no extraction (invents nothing)", () => {
    const payload = buildKeepRawPayload({ keepRaw: true }, pdfItem, {
      extraction: { kind: "image", extractor: "vision", warnings: ["no vision provider"] },
    }) as { file: Record<string, unknown> };
    expect("extractedText" in payload.file).toBe(false);
    expect("extractedTextTruncated" in payload.file).toBe(false);
  });

  it("keeps nothing for a URL item — there are no bytes to keep", () => {
    // The pod accepts `keepRaw: true` with no file and does nothing, so sending
    // it would be a claim the CLI cannot back.
    expect(buildKeepRawPayload({ keepRaw: true }, urlItem, {})).toEqual({});
  });
});

describe("keepRawLine reports the pod's ACTUAL disposition", () => {
  it("says nothing when nothing was kept", () => {
    expect(keepRawLine({})).toBeNull();
  });

  it("distinguishes all four outcomes", () => {
    expect(keepRawLine({ sourceFile: { status: "stored" } })).toMatch(/kept/);
    expect(
      keepRawLine({ sourceFile: { status: "proposed", reviewUrl: "https://pod/p/1" } })
    ).toMatch(/awaiting review — https:\/\/pod\/p\/1/);
    // A policy denial is NOT a storage failure, and neither is a save.
    expect(keepRawLine({ sourceFile: { status: "denied", reason: "over quota" } })).toMatch(
      /NOT kept — policy declined it: over quota/
    );
    expect(keepRawLine({ sourceFile: { status: "failed" } })).toMatch(
      /NOT kept — the pod could not store it/
    );
  });

  it("never claims a kept original for a proposed / denied / failed blob", () => {
    for (const status of ["proposed", "denied", "failed"] as const) {
      expect(keepRawLine({ sourceFile: { status } })).not.toMatch(
        /^original kept/
      );
    }
  });
});
