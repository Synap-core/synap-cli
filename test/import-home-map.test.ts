import { describe, it, expect } from "vitest";
import {
  parseHomeMap,
  applyHomeMapToPath,
} from "../src/commands/import.js";

describe("parseHomeMap", () => {
  it("parses comma-separated pathSubstring=workspace pairs", () => {
    expect(parseHomeMap("Projects=Builder,Posts=Content OS")).toEqual([
      { pathSubstring: "Projects", workspace: "Builder" },
      { pathSubstring: "Posts", workspace: "Content OS" },
    ]);
  });

  it("trims whitespace around keys and values", () => {
    expect(parseHomeMap("  Projects = Builder , Notes=Second Brain  ")).toEqual([
      { pathSubstring: "Projects", workspace: "Builder" },
      { pathSubstring: "Notes", workspace: "Second Brain" },
    ]);
  });

  it("rejects empty / malformed entries", () => {
    expect(() => parseHomeMap("")).toThrow(/Empty --home-map/);
    expect(() => parseHomeMap("Projects")).toThrow(/Invalid --home-map/);
    expect(() => parseHomeMap("=Builder")).toThrow(/Invalid --home-map/);
    expect(() => parseHomeMap("Projects=")).toThrow(/Invalid --home-map/);
  });
});

describe("applyHomeMapToPath", () => {
  const map = [
    { pathSubstring: "Projects", workspaceName: "Builder" },
    { pathSubstring: "Posts", workspaceName: "Content OS" },
  ];

  it("prefixes matched paths with workspace name (case-insensitive substring)", () => {
    expect(applyHomeMapToPath("5. Projects/foo.md", map)).toBe(
      "Builder/5. Projects/foo.md"
    );
    expect(applyHomeMapToPath("posts/draft.md", map)).toBe(
      "Content OS/posts/draft.md"
    );
  });

  it("does not double-prefix when path already starts with workspace name", () => {
    expect(applyHomeMapToPath("Builder/5. Projects/foo.md", map)).toBe(
      "Builder/5. Projects/foo.md"
    );
  });

  it("leaves unmatched paths unchanged", () => {
    expect(applyHomeMapToPath("misc/note.md", map)).toBe("misc/note.md");
  });

  it("uses first matching pair", () => {
    const overlapping = [
      { pathSubstring: "Project", workspaceName: "Short" },
      { pathSubstring: "Projects", workspaceName: "Builder" },
    ];
    // "Projects" contains "Project" — first match wins.
    expect(applyHomeMapToPath("Projects/x.md", overlapping)).toBe(
      "Short/Projects/x.md"
    );
  });
});
